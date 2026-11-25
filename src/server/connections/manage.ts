import "server-only";
import type { Queryable } from "../db";
import { AccessDeniedError, getCompanyAccess } from "../auth/authz";
import { getResourceForCompany, toDatasetRef } from "../registry/registry";
import { computeNextRun } from "../scheduling/schedule";
import type { RawRecord } from "../../lib/model";
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
  schedule: { frequency: "daily" | "manual"; local_time: string; timezone: string; enabled: boolean; next_run_at: string | null } | null;
  access: "manage" | "read";
}

export async function loadConnection(db: Queryable, userId: string, connectionId: string): Promise<ConnectionDetail | null> {
  if (!/^[0-9a-f-]{36}$/i.test(connectionId)) return null;
  const r = await db.query(
    `select c.id, c.company_id, c.workspace_id, c.provider_id, c.mode, c.status, c.external_account_id, c.external_account_name,
            c.last_synced_at, c.data_as_of::text as data_as_of, c.last_error, c.created_at,
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
): Promise<{ rows: RawRecord[]; available: boolean }> {
  const c = await loadConnection(db, userId, connectionId);
  if (!c) throw new AccessDeniedError();
  const resource = await getResourceForCompany(db, c.company_id);
  if (!resource || resource.status !== "ready") return { rows: [], available: false };
  const ids = await runIds(db, c.id);
  const wh = await getWarehouse(resource.provider);
  const { rows } = await wh.queryRaw(toDatasetRef(resource), ids, limit);
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
    await db.query<{ id: string; trigger: string; status: string; window_start: string | null; window_end: string | null; rows_written: number; attempts: number; error_code: string | null; created_at: Date }>(
      `select id, trigger, status, window_start::text, window_end::text, rows_written, attempts, error_code, created_at
         from public.sync_runs where connection_id = $1 order by created_at desc limit $2`,
      [connectionId, limit],
    )
  ).rows;
}
