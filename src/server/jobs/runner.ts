import { randomUUID } from "node:crypto";
import { loadConfig, type ServerConfig } from "../config";
import { getPool } from "../db";
import { getWarehouse } from "../warehouse";
import { ensureLocalWarehouseDatabase } from "../warehouse/local";
import { runMaintenanceOnce, runProvisioningOnce, runSyncOnce, startup, type WorkerDeps } from "../../worker/worker";

// Runs pending background work inside a request-scoped process (Vercel
// function, Next `after()`), within a time budget. Safe to call concurrently
// from many instances: jobs are claimed with SKIP LOCKED + leases.

let started: Promise<void> | null = null;

async function ensureStarted(deps: WorkerDeps, cfg: ServerConfig): Promise<void> {
  if (!started) {
    started = (async () => {
      if (cfg.warehouseMode === "local") await ensureLocalWarehouseDatabase(cfg.databaseUrl, cfg.warehouseLocalUrl);
      await startup(deps);
    })().catch((err) => {
      started = null;
      throw err;
    });
  }
  return started;
}

export interface RunSummary {
  provisioning: number;
  syncs: number;
  maintenance: { recovered: number; reconciled: number; enqueued: number } | null;
  stoppedBy: "idle" | "budget";
}

export async function runPendingWork(opts: { budgetMs: number; maintenance?: boolean; leaseSeconds?: number } ): Promise<RunSummary> {
  const cfg = loadConfig();
  const deps: WorkerDeps = {
    pool: getPool(),
    cfg,
    workerId: `web:${randomUUID().slice(0, 8)}`,
    getWarehouse: (p) => getWarehouse(p, cfg),
    // Leases must outlive the function's max duration so a frozen instance's job is recovered, not double-run.
    leaseSeconds: opts.leaseSeconds ?? 300,
  };
  await ensureStarted(deps, cfg);
  const deadline = Date.now() + opts.budgetMs;
  const summary: RunSummary = { provisioning: 0, syncs: 0, maintenance: null, stoppedBy: "idle" };
  if (opts.maintenance) summary.maintenance = await runMaintenanceOnce(deps);
  while (Date.now() < deadline) {
    const p = await runProvisioningOnce(deps);
    if (p !== "idle") summary.provisioning++;
    if (Date.now() >= deadline) break;
    const s = await runSyncOnce(deps);
    if (s !== "idle") summary.syncs++;
    if (p === "idle" && s === "idle") return summary;
  }
  summary.stoppedBy = "budget";
  return summary;
}

/** Whether web requests should process jobs themselves (default on; set RUN_JOBS_INLINE=false when a separate worker runs). */
export function inlineJobsEnabled(): boolean {
  return process.env.RUN_JOBS_INLINE !== "false";
}
