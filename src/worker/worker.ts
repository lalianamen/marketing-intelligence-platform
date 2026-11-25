import type pg from "pg";
import type { ServerConfig } from "../server/config";
import { redact } from "../server/crypto";
import { withTransaction } from "../server/db";
import { claimJob, completeJob, failJob, recoverExpiredLeases } from "../server/jobs/queue";
import { ProvisioningError, provisionCompanyDataset, reconcileProvisioning } from "../server/provisioning/provision";
import { clearCompanyData, deleteCompanyDataset, reconcileDeletions } from "../server/provisioning/deprovision";
import { ensureConfiguredProject } from "../server/registry/registry";
import { enqueueDueSyncs } from "../server/scheduling/schedule";
import { markConnectionFailure, processSyncRun, SyncError, type SyncDeps } from "../server/sync/runSync";
import type { Warehouse, WarehouseProvider } from "../server/warehouse/types";

// Background worker: provisioning, scheduled/manual/CSV syncs, reconciliation.
// Stateless; run one or many. Structured JSON logs carry job IDs, never secrets.

export interface WorkerDeps {
  pool: pg.Pool;
  cfg: ServerConfig;
  workerId: string;
  getWarehouse: (p: WarehouseProvider) => Promise<Warehouse>;
  now?: () => Date;
  leaseSeconds?: number;
  log?: (entry: Record<string, unknown>) => void;
  syncOverrides?: Pick<SyncDeps, "connectorOverride" | "fetchImpl">;
}

export function jsonLog(entry: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n");
}

export async function startup(deps: WorkerDeps): Promise<void> {
  const project = await ensureConfiguredProject(deps.pool, deps.cfg);
  (deps.log ?? jsonLog)({
    level: "info",
    msg: "worker.startup",
    worker: deps.workerId,
    warehouse_mode: deps.cfg.warehouseMode,
    project_registered: Boolean(project),
  });
}

export async function runProvisioningOnce(deps: WorkerDeps): Promise<"idle" | "succeeded" | "failed"> {
  const log = deps.log ?? jsonLog;
  const job = await claimJob(deps.pool, "provisioning_jobs", deps.workerId, deps.leaseSeconds ?? 300);
  if (!job) return "idle";
  const kind = job.kind === "delete_dataset" || job.kind === "clear_data" ? job.kind : "create_dataset";
  log({ level: "info", msg: "provisioning.start", job_id: job.id, company_id: job.company_id, kind, attempt: job.attempts });
  try {
    if (kind === "clear_data") {
      await clearCompanyData(deps.pool, job, { cfg: deps.cfg, getWarehouse: deps.getWarehouse });
      await completeJob(deps.pool, "provisioning_jobs", job, deps.workerId);
      log({ level: "info", msg: "company.data_cleared", job_id: job.id, company_id: job.company_id });
      return "succeeded";
    }
    if (kind === "delete_dataset") {
      const del = await deleteCompanyDataset(deps.pool, job, { cfg: deps.cfg, getWarehouse: deps.getWarehouse });
      // The job row is gone with the company (cascade); completing it is a no-op then.
      await completeJob(deps.pool, "provisioning_jobs", job, deps.workerId);
      log({ level: "info", msg: "company.deleted", job_id: job.id, company_id: job.company_id, dataset_dropped: del.dropped });
      return "succeeded";
    }
    const res = await provisionCompanyDataset(deps.pool, job, { cfg: deps.cfg, getWarehouse: deps.getWarehouse });
    await completeJob(deps.pool, "provisioning_jobs", job, deps.workerId);
    log({ level: "info", msg: "provisioning.succeeded", job_id: job.id, company_id: job.company_id, created: res.created });
    return "succeeded";
  } catch (err) {
    const e =
      err instanceof ProvisioningError
        ? { code: err.code, message: err.message, retryable: err.retryable }
        : { code: "unexpected", message: (err as Error).message, retryable: true };
    const outcome = await failJob(deps.pool, "provisioning_jobs", job, deps.workerId, e);
    if (outcome.status !== "queued" && kind === "create_dataset") {
      await deps.pool.query(
        `update public.analytics_resources set status = 'failed', updated_at = now() where company_id = $1 and status = 'preparing'`,
        [job.company_id],
      );
    }
    log({ level: "warn", msg: "provisioning.failed", job_id: job.id, company_id: job.company_id, code: e.code, error: redact(e.message), outcome });
    return "failed";
  }
}

export async function runSyncOnce(deps: WorkerDeps): Promise<"idle" | "succeeded" | "failed"> {
  const log = deps.log ?? jsonLog;
  const run = await claimJob(deps.pool, "sync_runs", deps.workerId, deps.leaseSeconds ?? 600, { maxRunningPerProvider: 4 });
  if (!run) return "idle";
  log({ level: "info", msg: "sync.start", sync_run_id: run.id, company_id: run.company_id, provider: run.provider_id, attempt: run.attempts });
  try {
    const out = await processSyncRun(deps.pool, run as never, {
      cfg: deps.cfg,
      getWarehouse: deps.getWarehouse,
      now: deps.now,
      ...deps.syncOverrides,
    });
    await completeJob(deps.pool, "sync_runs", run, deps.workerId, { rows_read: out.rowsRead, rows_written: out.rowsWritten });
    log({ level: "info", msg: "sync.succeeded", sync_run_id: run.id, rows: out.rowsWritten, window: out.window });
    return "succeeded";
  } catch (err) {
    const e =
      err instanceof SyncError
        ? { code: err.code, message: err.message, retryable: err.retryable }
        : { code: "unexpected", message: (err as Error).message, retryable: true };
    const outcome = await failJob(deps.pool, "sync_runs", run, deps.workerId, e);
    if (outcome.status !== "queued") {
      await markConnectionFailure(deps.pool, String(run.connection_id), e.message);
      if (run.csv_upload_id) await deps.pool.query(`update public.csv_uploads set status = 'failed', rows = '[]'::jsonb where id = $1`, [run.csv_upload_id]);
    }
    log({ level: "warn", msg: "sync.failed", sync_run_id: run.id, code: e.code, error: redact(e.message), outcome });
    return "failed";
  }
}

export async function runMaintenanceOnce(deps: WorkerDeps): Promise<{ recovered: number; reconciled: number; enqueued: number }> {
  const recovered =
    (await recoverExpiredLeases(deps.pool, "provisioning_jobs")) + (await recoverExpiredLeases(deps.pool, "sync_runs"));
  const reconciled = (await reconcileProvisioning(deps.pool)) + (await reconcileDeletions(deps.pool));
  // Validated CSV files that were never imported are not kept in the app database for more than 7 days.
  await deps.pool.query(
    `update public.csv_uploads set rows = '[]'::jsonb
      where status in ('validated', 'failed') and created_at < now() - interval '7 days' and jsonb_array_length(rows) > 0`,
  );
  const enqueued = await withTransaction((c) => enqueueDueSyncs(c, deps.now?.() ?? new Date()), deps.pool);
  if (recovered || reconciled || enqueued) {
    (deps.log ?? jsonLog)({ level: "info", msg: "maintenance", recovered, reconciled, enqueued });
  }
  return { recovered, reconciled, enqueued };
}

/** Drain all currently runnable work (used by tests and `npm run worker -- --once`). */
export async function drain(deps: WorkerDeps, maxIterations = 100): Promise<void> {
  await runMaintenanceOnce(deps);
  for (let i = 0; i < maxIterations; i++) {
    const p = await runProvisioningOnce(deps);
    const s = await runSyncOnce(deps);
    if (p === "idle" && s === "idle") return;
  }
}
