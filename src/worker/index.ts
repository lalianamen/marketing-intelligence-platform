import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import { loadConfig } from "../server/config";
import { closePool, getPool } from "../server/db";
import { getWarehouse } from "../server/warehouse";
import { ensureLocalWarehouseDatabase } from "../server/warehouse/local";
import { drain, jsonLog, runMaintenanceOnce, runProvisioningOnce, runSyncOnce, startup, type WorkerDeps } from "./worker";

// Local worker process: `npm run worker` (loop) or `npm run worker -- --once`.

async function main(): Promise<void> {
  const cfg = loadConfig();
  if (cfg.warehouseMode === "local") {
    await ensureLocalWarehouseDatabase(cfg.databaseUrl, cfg.warehouseLocalUrl);
  }
  const deps: WorkerDeps = {
    pool: getPool(),
    cfg,
    workerId: `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`,
    getWarehouse: (p) => getWarehouse(p, cfg),
  };
  await startup(deps);

  if (process.argv.includes("--once")) {
    await drain(deps);
    await closePool();
    process.exit(0);
  }

  let stopping = false;
  const stop = () => {
    stopping = true;
    jsonLog({ level: "info", msg: "worker.stopping" });
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  let lastMaintenance = 0;
  while (!stopping) {
    try {
      if (Date.now() - lastMaintenance > 30_000) {
        await runMaintenanceOnce(deps);
        lastMaintenance = Date.now();
      }
      const p = await runProvisioningOnce(deps);
      const s = await runSyncOnce(deps);
      if (p === "idle" && s === "idle") await new Promise((r) => setTimeout(r, 2000));
    } catch (err) {
      jsonLog({ level: "error", msg: "worker.loop_error", error: (err as Error).message });
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
  await closePool();
}

main().catch((err) => {
  jsonLog({ level: "fatal", msg: "worker.crashed", error: (err as Error).message });
  process.exit(1);
});
