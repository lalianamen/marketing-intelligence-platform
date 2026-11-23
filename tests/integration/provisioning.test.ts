import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { claimJob } from "@/server/jobs/queue";
import { datasetIdForCompany } from "@/server/warehouse/datasetId";
import { type Warehouse, WarehouseError } from "@/server/warehouse/types";
import { drain, runMaintenanceOnce, runProvisioningOnce } from "@/worker/worker";
import { cfg, createCompany, createVerifiedUser, localWarehouse, makeQueuedRunnable, onlyCompanies, pool, type TestUser, workerDeps } from "./helpers";

let U: TestUser;

beforeAll(async () => {
  U = await createVerifiedUser("prov");
});
afterAll(async () => {
  await pool.end();
});

async function resource(companyId: string) {
  return (await pool.query(`select * from public.analytics_resources where company_id = $1`, [companyId])).rows[0];
}
async function jobs(companyId: string) {
  return (await pool.query(`select * from public.provisioning_jobs where company_id = $1 order by created_at`, [companyId])).rows;
}

/** Wraps the real local warehouse and injects failures. */
function flaky(inner: Warehouse, failures: { method: keyof Warehouse; error: WarehouseError; times: number }): Warehouse {
  let left = failures.times;
  return new Proxy(inner, {
    get(target, prop, recv) {
      const v = Reflect.get(target, prop, recv);
      if (prop === failures.method && typeof v === "function") {
        return async (...args: unknown[]) => {
          if (left > 0) {
            left--;
            throw failures.error;
          }
          return (v as (...a: unknown[]) => unknown).apply(target, args);
        };
      }
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
}

describe("company provisioning", () => {
  it("creates a verified, labelled, schema-initialized dataset and shows ready status", async () => {
    const c = await createCompany(U, "Prov OK");
    await onlyCompanies([c]);
    const before = await U.client.from("provisioning_jobs").select("status").eq("company_id", c);
    expect(before.data).toEqual([{ status: "queued" }]); // UI shows "pending" immediately
    const deps = await workerDeps();
    await drain(deps);
    const r = await resource(c);
    expect(r).toMatchObject({ status: "ready", provider: "local", is_simulated: true, schema_version: 1, dataset_id: datasetIdForCompany("mip_test", c) });
    const wh = await localWarehouse();
    const labels = await wh.getDatasetLabels({ provider: "local", projectId: "local", datasetId: r.dataset_id, location: "local" });
    expect(labels).toMatchObject({ mip_company: c, mip_workspace: U.workspaceId });
    const ui = await U.client.from("analytics_resources").select("status,is_simulated").eq("company_id", c);
    expect(ui.data).toEqual([{ status: "ready", is_simulated: true }]);
    const attempts = await pool.query(`select status from public.job_attempts where job_id = $1`, [(await jobs(c))[0].id]);
    expect(attempts.rows).toEqual([{ status: "succeeded" }]);
  });

  it("duplicate/retried jobs never create a second dataset or double-count capacity", async () => {
    const c = await createCompany(U, "Prov Dup");
    await onlyCompanies([c]);
    const dup = await pool.query(
      `insert into public.provisioning_jobs (workspace_id, company_id, idempotency_key) values ($1, $2, 'dup-' || gen_random_uuid())`,
      [U.workspaceId, c],
    ).catch((e) => e);
    expect(String(dup.message ?? "")).toMatch(/provisioning_jobs_one_active/); // only one active job per company
    const deps = await workerDeps();
    const countBefore = (await pool.query(`select dataset_count from public.cloud_projects where provider = 'local'`)).rows[0].dataset_count;
    await drain(deps);
    // A manual extra job after ready is a no-op
    await pool.query(`insert into public.provisioning_jobs (workspace_id, company_id, idempotency_key) values ($1, $2, 'again-' || gen_random_uuid())`, [U.workspaceId, c]);
    await drain(deps);
    const countAfter = (await pool.query(`select dataset_count from public.cloud_projects where provider = 'local'`)).rows[0].dataset_count;
    expect(countAfter - countBefore).toBe(1);
    expect((await U.client.rpc("retry_provisioning", { p_company_id: c })).error?.message).toMatch(/already provisioned/);
  });

  it("recovers after a worker crash mid-job (expired lease → re-queued → completes once)", async () => {
    const c = await createCompany(U, "Prov Crash");
    await onlyCompanies([c]);
    const crashed = await claimJob(pool, "provisioning_jobs", "worker-that-dies", 300);
    expect(crashed?.company_id).toBe(c);
    await pool.query(`update public.provisioning_jobs set locked_until = now() - interval '1 second' where id = $1`, [crashed!.id]);
    const deps = await workerDeps();
    const m = await runMaintenanceOnce(deps);
    expect(m.recovered).toBeGreaterThanOrEqual(1);
    await drain(deps);
    expect((await resource(c)).status).toBe("ready");
    const att = await pool.query(`select status from public.job_attempts where job_id = $1 order by attempt`, [crashed!.id]);
    expect(att.rows.map((x) => x.status)).toEqual(["abandoned", "succeeded"]);
    // The dead worker can no longer complete/fail the job (fencing).
    const stale = await pool.query(`update public.provisioning_jobs set status = 'failed' where id = $1 and locked_by = 'worker-that-dies' and status = 'running'`, [crashed!.id]);
    expect(stale.rowCount).toBe(0);
  });

  it("adopts an existing dataset when the DB update was lost (dataset exists, registry not ready)", async () => {
    const c = await createCompany(U, "Prov Adopt");
    await onlyCompanies([c]);
    const wh = await localWarehouse();
    const datasetId = datasetIdForCompany("mip_test", c);
    await wh.ensureDataset({ provider: "local", projectId: "local", datasetId, location: "local" }, { mip_company: c, mip_workspace: U.workspaceId, mip_env: "mip_test" });
    const deps = await workerDeps();
    await drain(deps);
    const r = await resource(c);
    expect(r.status).toBe("ready");
    expect(r.dataset_id).toBe(datasetId);
    const audit = await pool.query(`select metadata from public.audit_logs where company_id = $1 and action = 'dataset.ready'`, [c]);
    expect(audit.rows[0].metadata.created).toBe(false);
  });

  it("never adopts a dataset labelled for another tenant", async () => {
    const c = await createCompany(U, "Prov Mismatch");
    await onlyCompanies([c]);
    const wh = await localWarehouse();
    await wh.ensureDataset(
      { provider: "local", projectId: "local", datasetId: datasetIdForCompany("mip_test", c), location: "local" },
      { mip_company: "00000000-0000-0000-0000-000000000001", mip_workspace: "x", mip_env: "mip_test" },
    );
    const deps = await workerDeps();
    await drain(deps);
    expect((await resource(c)).status).toBe("failed");
    const j = (await jobs(c))[0];
    expect(j).toMatchObject({ status: "failed", last_error_code: "dataset_owner_mismatch" });
    const ui = await U.client.from("provisioning_jobs").select("status").eq("company_id", c);
    expect(ui.data).toEqual([{ status: "failed" }]);
  });

  it("Google API timeout / quota errors are retried with backoff, then succeed", async () => {
    const c = await createCompany(U, "Prov Timeout");
    await onlyCompanies([c]);
    const real = await localWarehouse();
    const wh = flaky(real, { method: "ensureDataset", error: new WarehouseError("timeout", "deadline exceeded"), times: 1 });
    const wh2 = flaky(wh, { method: "ensureSchema", error: new WarehouseError("quota_exceeded", "quotaExceeded"), times: 1 });
    const deps = await workerDeps({ getWarehouse: async () => wh2 });
    expect(await runProvisioningOnce(deps)).toBe("failed");
    let j = (await jobs(c))[0];
    expect(j).toMatchObject({ status: "queued", attempts: 1, last_error_code: "warehouse_timeout" });
    expect(new Date(j.run_after).getTime()).toBeGreaterThan(Date.now());
    expect(await runProvisioningOnce(deps)).toBe("idle"); // respects backoff
    await makeQueuedRunnable();
    expect(await runProvisioningOnce(deps)).toBe("failed");
    j = (await jobs(c))[0];
    expect(j).toMatchObject({ status: "queued", attempts: 2, last_error_code: "warehouse_quota_exceeded" });
    await makeQueuedRunnable();
    expect(await runProvisioningOnce(deps)).toBe("succeeded");
    expect((await resource(c)).status).toBe("ready");
  });

  it("gives up after max attempts (dead) and allows a manual retry from the UI", async () => {
    const c = await createCompany(U, "Prov Dead");
    await onlyCompanies([c]);
    await pool.query(`update public.provisioning_jobs set max_attempts = 2 where company_id = $1`, [c]);
    const wh = flaky(await localWarehouse(), { method: "ensureDataset", error: new WarehouseError("unavailable", "503"), times: 2 });
    const deps = await workerDeps({ getWarehouse: async () => wh });
    await runProvisioningOnce(deps);
    await makeQueuedRunnable();
    await runProvisioningOnce(deps);
    expect((await jobs(c))[0].status).toBe("dead");
    expect((await resource(c)).status).toBe("failed");
    const retry = await U.client.rpc("retry_provisioning", { p_company_id: c });
    expect(retry.error).toBeNull();
    await drain(deps);
    expect((await resource(c)).status).toBe("ready");
  });

  it("reconciliation recreates a lost job for a company without a dataset", async () => {
    const c = await createCompany(U, "Prov Lost");
    await onlyCompanies([c]);
    await pool.query(`delete from public.job_attempts where company_id = $1`, [c]);
    await pool.query(`delete from public.provisioning_jobs where company_id = $1`, [c]);
    const deps = await workerDeps();
    const m = await runMaintenanceOnce(deps);
    expect(m.reconciled).toBeGreaterThanOrEqual(1);
    await drain(deps);
    expect((await resource(c)).status).toBe("ready");
  });

  it("real BigQuery mode without billing approval creates nothing and reports why", async () => {
    const c = await createCompany(U, "Prov BQ no billing");
    await onlyCompanies([c]);
    const deps = await workerDeps({ cfg: { ...cfg, warehouseMode: "bigquery", bigquery: { ...cfg.bigquery, projectId: "mip-dev-project", billingApproved: false } } });
    await runProvisioningOnce(deps);
    expect(await resource(c)).toBeUndefined();
    expect((await jobs(c))[0]).toMatchObject({ status: "failed", last_error_code: "billing_not_approved" });
    await pool.query(`delete from public.cloud_projects where provider = 'bigquery' and project_id = 'mip-dev-project'`);
  });
});
