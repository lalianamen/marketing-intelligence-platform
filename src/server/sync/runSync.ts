import { enumerateDates, localDate } from "../../lib/dates";
import type { NormalizedRow } from "../../lib/model";
import type { ServerConfig } from "../config";
import { decryptSecret, redact } from "../crypto";
import type { Queryable } from "../db";
import { connectorFor } from "../connectors/factory";
import type { FetchLike } from "../connectors/google";
import { type Connector, ConnectorError } from "../connectors/types";
import type { CsvRow } from "../ingestion/csv";
import { extraRawRecords, normalizeCsvRows, normalizeProviderRecords } from "../ingestion/normalize";
import type { ClaimedJob } from "../jobs/queue";
import { getResourceForCompany, toDatasetRef } from "../registry/registry";
import { recordUsage } from "../usage/usage";
import { type Warehouse, WarehouseError, type WarehouseProvider } from "../warehouse/types";
import { computeSyncWindow } from "./window";
import { addDays } from "../../lib/dates";

// Shared sync engine for every source:
// fetch → RAW → NORMALIZED (upsert by grain) → MART rebuild for touched dates →
// validation → checkpoint/freshness. A successful provider response alone is
// not treated as proof of completeness: coverage and pagination are checked.

export class SyncError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

export interface SyncDeps {
  cfg: ServerConfig;
  getWarehouse: (p: WarehouseProvider) => Promise<Warehouse>;
  now?: () => Date;
  /** Test hook: override connector resolution. */
  connectorOverride?: (providerId: string, mode: string) => Connector;
  fetchImpl?: FetchLike;
}

interface RunContext {
  run: ClaimedJob & {
    connection_id: string;
    provider_id: string;
    window_start: string | null;
    window_end: string | null;
    csv_upload_id: string | null;
  };
}

export interface SyncOutcome {
  rowsRead: number;
  rowsWritten: number;
  window: { from: string; to: string } | null;
  dataAsOf: string | null;
}

async function addIssue(
  db: Queryable,
  run: RunContext["run"],
  severity: "info" | "warning" | "error",
  code: string,
  message: string,
  details: Record<string, unknown> = {},
  metricDate: string | null = null,
): Promise<void> {
  await db.query(
    `insert into public.data_quality_issues (workspace_id, company_id, connection_id, sync_run_id, severity, code, message, details, metric_date)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [run.workspace_id, run.company_id, run.connection_id, run.id, severity, code, message, JSON.stringify(details), metricDate],
  );
}

function qualityChecks(rows: NormalizedRow[]): { code: string; message: string; date: string }[] {
  const issues: { code: string; message: string; date: string }[] = [];
  for (const r of rows) {
    if (r.clicks !== null && r.impressions !== null && r.clicks > r.impressions) {
      issues.push({ code: "clicks_exceed_impressions", message: `Clicks exceed impressions for ${r.campaign_name ?? r.campaign_id}`, date: r.metric_date });
    }
    if ((r.spend !== null || r.attributed_revenue !== null) && !r.currency) {
      issues.push({ code: "missing_currency", message: `Money values without currency for ${r.campaign_name ?? r.campaign_id}`, date: r.metric_date });
    }
  }
  return issues.slice(0, 50);
}

export async function processSyncRun(db: Queryable, run: RunContext["run"], deps: SyncDeps): Promise<SyncOutcome> {
  const now = deps.now?.() ?? new Date();
  const conn = (
    await db.query<{
      id: string;
      company_id: string;
      provider_id: string;
      mode: "live" | "simulated" | "manual";
      status: string;
      external_account_id: string | null;
      data_as_of: string | null;
      settings: { ga4_reports?: string[] } | null;
    }>(`select * from public.company_connections where id = $1 and company_id = $2`, [run.connection_id, run.company_id])
  ).rows[0];
  if (!conn) throw new SyncError("connection_missing", "connection not found", false);
  if (conn.status === "disconnected") throw new SyncError("connection_disconnected", "connection was disconnected", false);

  const company = (
    await db.query<{ timezone: string }>(`select timezone from public.companies where id = $1 and workspace_id = $2`, [
      run.company_id,
      run.workspace_id,
    ])
  ).rows[0];
  if (!company) throw new SyncError("company_missing", "company not found", false);

  const resource = await getResourceForCompany(db, run.company_id);
  if (!resource || resource.status !== "ready") {
    throw new SyncError("dataset_not_ready", "the company's data space is not ready yet", true);
  }
  if (resource.workspace_id !== run.workspace_id) throw new SyncError("tenant_mismatch", "resource tenant mismatch", false);
  const ref = toDatasetRef(resource);
  const wh = await deps.getWarehouse(resource.provider);
  const today = localDate(now, company.timezone);

  let normalized: NormalizedRow[];
  let rawCount = 0;
  let window: { from: string; to: string } | null = null;
  let connector: Connector | null = null;
  let apiCalls = 0;

  try {
    if (conn.provider_id === "csv") {
      if (!run.csv_upload_id) throw new SyncError("csv_upload_missing", "CSV sync run without upload", false);
      const up = (
        await db.query<{ rows: CsvRow[] }>(`select rows from public.csv_uploads where id = $1 and company_id = $2`, [
          run.csv_upload_id,
          run.company_id,
        ])
      ).rows[0];
      if (!up) throw new SyncError("csv_upload_missing", "CSV upload not found", false);
      if (!Array.isArray(up.rows) || up.rows.length === 0) throw new SyncError("csv_upload_expired", "CSV rows are no longer stored; upload the file again", false);
      const out = normalizeCsvRows(up.rows, { syncRunId: run.id, companyTimezone: company.timezone, now });
      normalized = out.normalized;
      const w = await wh.insertRaw(ref, out.raw);
      rawCount = w.written;
    } else {
      connector = deps.connectorOverride?.(conn.provider_id, conn.mode) ?? connectorFor(conn.provider_id, conn.mode, deps.cfg, deps.fetchImpl);
      const checkpoint = (
        await db.query<{ cursor_date: string | null }>(`select cursor_date from public.sync_checkpoints where connection_id = $1`, [conn.id])
      ).rows[0];
      window =
        run.window_start && run.window_end
          ? { from: run.window_start, to: run.window_end }
          : computeSyncWindow({
              now,
              timezone: company.timezone,
              cursorDate: checkpoint?.cursor_date ?? null,
              lookbackDays: connector.lookbackDays,
              initialBackfillDays: deps.cfg.initialBackfillDays,
            });
      if (!window) {
        return { rowsRead: 0, rowsWritten: 0, window: null, dataAsOf: conn.data_as_of };
      }
      await db.query(`update public.sync_runs set window_start = $2, window_end = $3 where id = $1`, [run.id, window.from, window.to]);

      let credentials: { refreshToken: string } | undefined;
      if (conn.mode === "live") {
        const secret = (
          await db.query<{ ciphertext: string }>(`select ciphertext from public.connection_secrets where connection_id = $1`, [conn.id])
        ).rows[0];
        if (!secret || !deps.cfg.tokenEncryptionKey) throw new ConnectorError("auth_expired", "no stored authorization");
        credentials = { refreshToken: decryptSecret(secret.ciphertext, deps.cfg.tokenEncryptionKey, conn.id) };
      }
      const fetched = await connector.fetchDaily({
        window,
        externalAccountId: conn.external_account_id ?? "",
        companyId: run.company_id,
        companyTimezone: company.timezone,
        credentials,
        now,
        options: { ga4Reports: conn.settings?.ga4_reports ?? [] },
      });
      apiCalls = fetched.apiCalls;
      if (!fetched.complete) {
        throw new ConnectorError("incomplete_data", `provider returned an incomplete result: ${fetched.notes.join(" ")}`);
      }
      for (const note of fetched.notes) await addIssue(db, run, "info", "provider_note", note);
      for (const e of fetched.extraErrors ?? []) {
        await addIssue(db, run, "warning", "extra_report_failed", `Extra GA4 report "${e.report}" was not loaded: ${redact(e.message)}`, { report: e.report });
      }
      const out = normalizeProviderRecords(fetched.records, {
        syncRunId: run.id,
        origin: connector.origin,
        isSimulated: connector.mode === "simulated",
        today,
        finalizationDays: connector.finalizationDays,
        now,
      });
      normalized = out.normalized.filter((r) => r.metric_date >= window!.from && r.metric_date <= window!.to);
      if (normalized.length !== out.normalized.length) {
        await addIssue(db, run, "warning", "rows_outside_window", "Provider returned rows outside the requested window; they were ignored.");
      }
      // An API sync is the source of truth for its window: rows the provider no longer
      // returns (renamed or regrouped campaigns) must not linger and double count —
      // neither in the normalized table nor in the raw table.
      const runIds = (await db.query<{ id: string }>(`select id from public.sync_runs where connection_id = $1`, [conn.id])).rows.map((r) => r.id);
      // Raw rows are replaced only for the reports fetched completely in this run; a failed
      // extra report keeps its previous rows rather than losing them.
      await wh.deleteConnectionData(ref, {
        origin: connector.origin,
        isSimulated: conn.mode === "simulated",
        accountId: conn.mode === "live" ? (conn.external_account_id ?? "") : null,
        syncRunIds: runIds,
        range: window,
        rawSources: [connector.origin, ...(fetched.extraFetched ?? []).map((id) => `${connector!.origin}:${id}`)],
      });
      const extra = extraRawRecords(fetched.extraRaw ?? [], {
        syncRunId: run.id,
        origin: connector.origin,
        accountId: conn.external_account_id ?? "",
        isSimulated: connector.mode === "simulated",
        now,
        window,
      });
      const w = await wh.insertRaw(ref, [...out.raw, ...extra]);
      rawCount = w.written;
    }

    const upsert = await wh.upsertNormalized(ref, normalized);
    const dates = normalized.map((r) => r.metric_date).sort();
    const touched = dates.length ? { from: dates[0]!, to: dates[dates.length - 1]! } : null;
    const martRange =
      window && touched
        ? { from: window.from < touched.from ? window.from : touched.from, to: window.to > touched.to ? window.to : touched.to }
        : (window ?? touched);
    if (martRange) await wh.rebuildMart(ref, martRange);

    // Validation: days with no rows inside the window (could be zero activity or
    // missing data — reported, never invented).
    if (window) {
      const covered = new Set(await wh.coveredDates(ref, connector!.origin, window));
      const missing = enumerateDates(window.from, window.to).filter((d) => !covered.has(d));
      if (missing.length) {
        await addIssue(db, run, "info", "no_rows_for_dates", `No rows were returned for ${missing.length} day(s) in the synced window.`, {
          dates: missing.slice(0, 60),
        });
      }
    }
    for (const q of qualityChecks(normalized)) await addIssue(db, run, "warning", q.code, q.message, {}, q.date);

    const dataAsOf = touched?.to ?? null;
    if (window) {
      await db.query(
        `insert into public.sync_checkpoints (connection_id, workspace_id, company_id, cursor_date, last_sync_run_id, updated_at)
         values ($1, $2, $3, $4, $5, now())
         on conflict (connection_id) do update set
           cursor_date = greatest(coalesce(public.sync_checkpoints.cursor_date, excluded.cursor_date), excluded.cursor_date),
           last_sync_run_id = excluded.last_sync_run_id, updated_at = now()`,
        [conn.id, run.workspace_id, run.company_id, window.to, run.id],
      );

      // Caught up only part of a long gap (one month per run): queue the next part right away.
      if (connector && window && !run.window_start) {
        const yesterday = addDays(localDate(now, company.timezone), -1);
        if (window.to < yesterday) {
          await db.query(
            `insert into public.sync_runs (workspace_id, company_id, connection_id, provider_id, trigger, idempotency_key, is_simulated)
             values ($1, $2, $3, $4, 'scheduled', $5, $6)
             on conflict (idempotency_key) do nothing`,
            [run.workspace_id, run.company_id, conn.id, conn.provider_id, `catchup:${conn.id}:${window.to}`, conn.mode === "simulated"],
          );
        }
      }
    }
    await db.query(
      `update public.company_connections
          set last_synced_at = $2, status = 'connected', last_error = null, consecutive_failures = 0, updated_at = now(),
              data_as_of = case when $3::date is null then data_as_of else greatest(coalesce(data_as_of, $3::date), $3::date) end
        where id = $1`,
      [conn.id, now, dataAsOf],
    );
    // Business numbers live only in the warehouse: the CSV rows are dropped from the app database once imported.
    if (run.csv_upload_id) await db.query(`update public.csv_uploads set status = 'imported', rows = '[]'::jsonb where id = $1`, [run.csv_upload_id]);

    await recordUsage(db, {
      workspaceId: run.workspace_id,
      companyId: run.company_id,
      kind: "warehouse_rows_written",
      quantity: upsert.written + rawCount,
      unit: "rows",
      bytesProcessed: upsert.stats.bytesProcessed,
      bytesBilled: upsert.stats.bytesBilled,
      metadata: { sync_run_id: run.id, provider: conn.provider_id, warehouse: resource.provider },
    });
    if (apiCalls > 0) {
      await recordUsage(db, {
        workspaceId: run.workspace_id,
        companyId: run.company_id,
        kind: "provider_api_call",
        quantity: apiCalls,
        unit: "requests",
        metadata: { provider: conn.provider_id },
      });
    }
    return { rowsRead: normalized.length, rowsWritten: upsert.written, window, dataAsOf };
  } catch (err) {
    if (err instanceof ConnectorError) {
      if (err.code === "auth_expired" || err.code === "permission_denied") {
        await db.query(
          `update public.company_connections set status = $2, last_error = $3, consecutive_failures = consecutive_failures + 1, updated_at = now() where id = $1`,
          [conn.id, err.code === "auth_expired" ? "expired" : "error", redact(err.message)],
        );
      }
      throw new SyncError(err.code, err.message, err.retryable);
    }
    if (err instanceof WarehouseError) throw new SyncError(`warehouse_${err.code}`, err.message, err.retryable);
    if (err instanceof SyncError) throw err;
    throw new SyncError("unexpected", (err as Error).message, true);
  }
}

/** Called when a run ends in failed/dead so the UI shows a plain status. */
export async function markConnectionFailure(db: Queryable, connectionId: string, message: string): Promise<void> {
  await db.query(
    `update public.company_connections
        set status = case when status in ('expired', 'disconnected') then status else 'error' end,
            last_error = $2, consecutive_failures = consecutive_failures + 1, updated_at = now()
      where id = $1`,
    [connectionId, redact(message)],
  );
}
