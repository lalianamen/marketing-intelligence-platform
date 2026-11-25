import "server-only";
import type { Queryable } from "../db";
import { AccessDeniedError, getCompanyAccess } from "../auth/authz";
import { getResourceForCompany, toDatasetRef } from "../registry/registry";
import { computeNextRun } from "../scheduling/schedule";
import type { RawRecord } from "../../lib/model";
import { GA4_OPTIONAL_FIELDS, GA4_OPTIONAL_GROUPS, ga4SelectionProblem, isGa4SelectionItem, sanitizeGa4Selection } from "../../lib/ga4Catalog";
import { type RawColumn, type RawTableParams, rawColumnsFor } from "../../lib/rawTable";
import type { Warehouse, WarehouseProvider } from "../warehouse/types";

// One connector's page: details, schedule, raw rows, delete. Every function
// checks the signed-in user's access to the connection's company first.

export interface ConnectionDetail {
  id: string;
  company_id: string;
  workspace_id: string;
  provider_id: string;
  mode: "live" | "simulated" | "manual";
  status: string;
  external_account_id: string | null;
  external_account_name: string | null;
  last_synced_at: string | null;
  data_as_of: string | null;
  last_error: string | null;
  created_at: string;
  settings: { ga4_reports?: string[] };
  /** null while the connector is in setup (nothing loads yet). */
  activated_at: string | null;
  schedule: { frequency: "daily" | "manual"; local_time: string; timezone: string; enabled: boolean; next_run_at: string | null } | null;
  access: "manage" | "read";
}

export async function loadConnection(db: Queryable, userId: string, connectionId: string): Promise<ConnectionDetail | null> {
  if (!/^[0-9a-f-]{36}$/i.test(connectionId)) return null;
  const r = await db.query(
    `select c.id, c.company_id, c.workspace_id, c.provider_id, c.mode, c.status, c.external_account_id, c.external_account_name,
            c.last_synced_at, c.data_as_of::text as data_as_of, c.last_error, c.created_at, c.settings, c.activated_at,
            s.frequency, to_char(s.local_time, 'HH24:MI') as local_time, s.timezone, s.enabled, s.next_run_at
       from public.company_connections c
       left join public.sync_schedules s on s.connection_id = c.id
      where c.id = $1 and c.status <> 'disconnected'`,
    [connectionId],
  );
  const row = r.rows[0];
  if (!row) return null;
  const access = await getCompanyAccess(db, userId, row.company_id);
  if (!access) return null;
  return {
    ...row,
    last_synced_at: row.last_synced_at ? new Date(row.last_synced_at).toISOString() : null,
    created_at: new Date(row.created_at).toISOString(),
    activated_at: row.activated_at ? new Date(row.activated_at).toISOString() : null,
    schedule: row.frequency
      ? { frequency: row.frequency, local_time: row.local_time, timezone: row.timezone, enabled: row.enabled, next_run_at: row.next_run_at ? new Date(row.next_run_at).toISOString() : null }
      : null,
    access,
  };
}

async function requireManage(db: Queryable, userId: string, connectionId: string): Promise<ConnectionDetail> {
  const c = await loadConnection(db, userId, connectionId);
  if (!c || c.access !== "manage") throw new AccessDeniedError();
  return c;
}

/** Change when (or whether) the connector updates automatically. */
export async function updateSchedule(
  db: Queryable,
  userId: string,
  connectionId: string,
  input: { frequency: string; localTime: string },
  now: Date = new Date(),
): Promise<void> {
  const c = await requireManage(db, userId, connectionId);
  if (c.mode === "manual") throw new Error("CSV uploads have no schedule");
  if (input.frequency !== "daily" && input.frequency !== "manual") throw new Error("invalid frequency");
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(input.localTime)) throw new Error("invalid time");
  const s = (await db.query<{ timezone: string; buffer_minutes: number }>(`select timezone, buffer_minutes from public.sync_schedules where connection_id = $1`, [c.id])).rows[0];
  if (!s) throw new Error("schedule not found");
  const next =
    input.frequency === "daily"
      ? computeNextRun({ after: now, localTime: input.localTime, timezone: s.timezone, bufferMinutes: 0, jitterSeed: c.id })
      : null;
  await db.query(
    `update public.sync_schedules
        set frequency = $2, local_time = $3::time, buffer_minutes = 0, enabled = $4, next_run_at = $5, updated_at = now()
      where connection_id = $1`,
    [c.id, input.frequency, input.localTime, input.frequency === "daily", next],
  );
  await db.query(
    `insert into public.audit_logs (workspace_id, company_id, actor_user_id, action, target_type, target_id, metadata)
     values ($1, $2, $3, 'connection.schedule_changed', 'connection', $4, $5)`,
    [c.workspace_id, c.company_id, userId, c.id, JSON.stringify({ frequency: input.frequency, local_time: input.localTime })],
  );
}

async function runIds(db: Queryable, connectionId: string): Promise<string[]> {
  return (await db.query<{ id: string }>(`select id from public.sync_runs where connection_id = $1`, [connectionId])).rows.map((r) => r.id);
}

/** Raw records this connector imported (identical payloads once), newest day first. */
export async function loadRawRows(
  db: Queryable,
  getWarehouse: (p: WarehouseProvider) => Promise<Warehouse>,
  userId: string,
  connectionId: string,
  limit = 500,
  source?: string,
): Promise<{ rows: RawRecord[]; available: boolean }> {
  const c = await loadConnection(db, userId, connectionId);
  if (!c) throw new AccessDeniedError();
  const resource = await getResourceForCompany(db, c.company_id);
  if (!resource || resource.status !== "ready") return { rows: [], available: false };
  const ids = await runIds(db, c.id);
  const wh = await getWarehouse(resource.provider);
  const { rows } = await wh.queryRaw(toDatasetRef(resource), ids, limit, source);
  return { rows, available: true };
}

/**
 * Delete a connector and the data it imported: its normalized and raw rows,
 * the affected mart days (rebuilt from what remains), runs, schedule and token.
 */
export async function deleteConnection(
  db: Queryable,
  getWarehouse: (p: WarehouseProvider) => Promise<Warehouse>,
  userId: string,
  connectionId: string,
): Promise<{ name: string }> {
  const c = await requireManage(db, userId, connectionId);
  const running = await db.query(`select 1 from public.sync_runs where connection_id = $1 and status = 'running' limit 1`, [c.id]);
  if (running.rowCount) throw new Error("connection busy");
  const ids = await runIds(db, c.id);
  const resource = await getResourceForCompany(db, c.company_id);
  if (resource?.status === "ready") {
    const ref = toDatasetRef(resource);
    const wh = await getWarehouse(resource.provider);
    const { range } = await wh.deleteConnectionData(ref, {
      origin: c.provider_id,
      isSimulated: c.mode === "simulated",
      accountId: c.mode === "live" ? c.external_account_id : null,
      syncRunIds: ids,
    });
    if (range) await wh.rebuildMart(ref, range);
  }
  await db.query(`update public.sync_runs set status = 'cancelled', finished_at = now() where connection_id = $1 and status = 'queued'`, [c.id]);
  await db.query(`delete from public.sync_runs where connection_id = $1`, [c.id]);
  if (c.provider_id === "csv") await db.query(`delete from public.csv_uploads where company_id = $1`, [c.company_id]);
  await db.query(`delete from public.company_connections where id = $1`, [c.id]);
  const name = c.external_account_name ?? c.provider_id;
  await db.query(
    `insert into public.audit_logs (workspace_id, company_id, actor_user_id, action, target_type, target_id, metadata)
     values ($1, $2, $3, 'connection.deleted', 'connection', $4, $5)`,
    [c.workspace_id, c.company_id, userId, c.id, JSON.stringify({ provider: c.provider_id, mode: c.mode, name })],
  );
  return { name };
}

export async function loadRuns(db: Queryable, connectionId: string, limit = 20) {
  return (
    await db.query<{ id: string; trigger: string; status: string; window_start: string | null; window_end: string | null; rows_written: number; attempts: number; error_code: string | null; created_at: Date; run_after: Date }>(
      `select id, trigger, status, window_start::text, window_end::text, rows_written, attempts, error_code, created_at, run_after
         from public.sync_runs where connection_id = $1 order by created_at desc limit $2`,
      [connectionId, limit],
    )
  ).rows;
}

/**
 * Switch an extra GA4 report on or off for a connector. Off also deletes that
 * report's raw rows, so stale data cannot be mistaken for current data.
 * Returns whether a backfill should be requested (report switched on).
 */
export async function setGa4Report(
  db: Queryable,
  getWarehouse: (p: WarehouseProvider) => Promise<Warehouse>,
  userId: string,
  connectionId: string,
  groupId: string,
  on: boolean,
): Promise<{ changed: boolean }> {
  const c = await requireManage(db, userId, connectionId);
  if (!GA4_OPTIONAL_GROUPS.some((g) => g.id === groupId)) throw new Error("unknown report");
  const current = sanitizeGa4Selection(c.settings?.ga4_reports);
  const groupFields = GA4_OPTIONAL_FIELDS.filter((f) => f.group === groupId).map((f) => f.name);
  return setGa4Groups(db, getWarehouse, userId, connectionId, on ? [...current, ...groupFields] : current.filter((f) => !groupFields.includes(f)));
}

/**
 * Saves the whole chosen set of GA4 fields at once (the user picks first, then saves).
 * Items are field names; a group id stands for all of its fields.
 */
export async function setGa4Groups(
  db: Queryable,
  _getWarehouse: (p: WarehouseProvider) => Promise<Warehouse>,
  userId: string,
  connectionId: string,
  items: string[],
): Promise<{ changed: boolean; added: string[]; removed: string[] }> {
  const c = await requireManage(db, userId, connectionId);
  if (c.provider_id !== "ga4" || c.mode !== "live") throw new Error("data groups can be chosen only for live GA4 connectors");
  if (items.some((g) => !isGa4SelectionItem(g))) throw new Error("unknown report");
  const current = sanitizeGa4Selection(c.settings?.ga4_reports);
  const next = sanitizeGa4Selection(items);
  const problem = ga4SelectionProblem(next);
  if (problem) throw new Error(problem);
  const added = next.filter((g) => !current.includes(g));
  const removed = current.filter((g) => !next.includes(g));
  // Older settings stored group ids: rewrite them as field names even when the fields are the same.
  const stored = Array.isArray(c.settings?.ga4_reports) ? c.settings!.ga4_reports!.map(String) : [];
  if (added.length === 0 && removed.length === 0) {
    if (JSON.stringify(stored) !== JSON.stringify(next)) {
      await db.query(`update public.company_connections set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{ga4_reports}', $2::jsonb) where id = $1`, [c.id, JSON.stringify(next)]);
    }
    return { changed: false, added, removed };
  }
  await db.query(
    `update public.company_connections set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{ga4_reports}', $2::jsonb), updated_at = now() where id = $1`,
    [c.id, JSON.stringify(next)],
  );
  await db.query(
    `insert into public.audit_logs (workspace_id, company_id, actor_user_id, action, target_type, target_id, metadata)
     values ($1, $2, $3, 'connection.report_toggled', 'connection', $4, $5)`,
    [c.workspace_id, c.company_id, userId, c.id, JSON.stringify({ fields: next, added, removed })],
  );
  return { changed: true, added, removed };
}

/** One page (or an export) of a connector's raw rows with period, filters and sorting. */
export async function loadRawPage(
  db: Queryable,
  getWarehouse: (p: WarehouseProvider) => Promise<Warehouse>,
  userId: string,
  connectionId: string,
  params: RawTableParams,
  opts: { source?: string; limit: number; offset: number; ignoreFilters?: boolean },
): Promise<{ columns: RawColumn[]; rows: RawRecord[]; total: number; available: boolean; origin: string; suggestions: Record<string, string[]> }> {
  const c = await loadConnection(db, userId, connectionId);
  if (!c) throw new AccessDeniedError();
  const resource = await getResourceForCompany(db, c.company_id);
  if (!resource || resource.status !== "ready") return { columns: [], rows: [], total: 0, available: false, origin: c.provider_id, suggestions: {} };
  const ids = await runIds(db, c.id);
  const wh = await getWarehouse(resource.provider);
  const ref = toDatasetRef(resource);
  const sample = await wh.queryRawPage(ref, { syncRunIds: ids, source: opts.source, limit: 20, offset: 0 });
  const columns = rawColumnsFor(c.provider_id, sample.rows.map((r) => r.payload_json), c.settings?.ga4_reports);
  const byLabel = new Map(columns.map((col) => [col.label, col.path]));
  const filters = opts.ignoreFilters
    ? []
    : params.filters.filter((f) => byLabel.has(f.col) && (f.op === "contains" || f.op === "eq" || Number.isFinite(Number(f.value))))
        .map((f) => ({ path: byLabel.get(f.col)!, op: f.op, value: f.value }));
  const sortBy = params.sort === "imported" ? "ingested_at" : byLabel.get(params.sort) ?? "record_date";
  const page = await wh.queryRawPage(ref, {
    syncRunIds: ids,
    source: opts.source,
    from: opts.ignoreFilters ? undefined : (params.from ?? undefined),
    to: opts.ignoreFilters ? undefined : (params.to ?? undefined),
    filters,
    sort: opts.ignoreFilters ? undefined : { by: sortBy, dir: params.dir },
    limit: opts.limit,
    offset: opts.offset,
  });
  // Real values for the columns chosen in the filters, so users pick "(referral)" instead of guessing.
  const suggestions: Record<string, string[]> = {};
  if (!opts.ignoreFilters) {
    for (const col of [...new Set(params.filters.map((f) => f.col).concat(params.suggestFor ?? []))].slice(0, 3)) {
      const path = byLabel.get(col);
      if (path) suggestions[col] = await wh.rawValues(ref, { syncRunIds: ids, source: opts.source, path, limit: 50 });
    }
  }
  return { columns, rows: page.rows, total: page.total, available: true, origin: c.provider_id, suggestions };
}

/**
 * Changing what a connector collects after its first load restarts it: all its
 * stored rows (dashboard and raw) are deleted, the dashboard days are rebuilt,
 * queued parts are cancelled, and the last 30 complete days are returned so the
 * caller can queue a fresh load with the new set of data.
 */
export async function clearConnectorForReload(
  db: Queryable,
  getWarehouse: (p: WarehouseProvider) => Promise<Warehouse>,
  userId: string,
  connectionId: string,
  yesterday: string,
): Promise<{ from: string; to: string }> {
  const c = await requireManage(db, userId, connectionId);
  const running = await db.query(`select 1 from public.sync_runs where connection_id = $1 and status = 'running' limit 1`, [c.id]);
  if (running.rowCount) throw new Error("connection busy");
  await db.query(`update public.sync_runs set status = 'cancelled', finished_at = now() where connection_id = $1 and status = 'queued'`, [c.id]);
  let from: string | null = null;
  const resource = await getResourceForCompany(db, c.company_id);
  if (resource?.status === "ready") {
    const ref = toDatasetRef(resource);
    const wh = await getWarehouse(resource.provider);
    const { range } = await wh.deleteConnectionData(ref, {
      origin: c.provider_id,
      isSimulated: c.mode === "simulated",
      accountId: c.mode === "live" ? c.external_account_id : null,
      syncRunIds: await runIds(db, c.id),
    });
    if (range) {
      await wh.rebuildMart(ref, range);
      from = range.from;
    }
  }
  await db.query(`delete from public.sync_checkpoints where connection_id = $1`, [c.id]);
  await db.query(
    `insert into public.audit_logs (workspace_id, company_id, actor_user_id, action, target_type, target_id)
     values ($1, $2, $3, 'connection.data_restarted', 'connection', $4)`,
    [c.workspace_id, c.company_id, userId, c.id],
  );
  void from;
  // After a change of the collected data, only the last 30 complete days are loaded again.
  return { from: addDaysIso(yesterday, -29), to: yesterday };
}

function addDaysIso(d: string, n: number): string {
  const t = new Date(d + "T00:00:00Z");
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
}
