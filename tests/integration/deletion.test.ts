import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { storeValidatedUpload } from "@/server/ingestion/uploads";
import { drain } from "@/worker/worker";
import { createCompany, createVerifiedUser, localWarehouse, onlyCompanies, pool, type TestUser, workerDeps } from "./helpers";

let A: TestUser;
let B: TestUser;

beforeAll(async () => {
  A = await createVerifiedUser("delA");
  B = await createVerifiedUser("delB");
});
afterAll(async () => {
  await pool.end();
});

const CSV = "date,source,campaign_name,currency,spend,clicks\n2026-11-01,google,Brand,USD,10.50,7\n";

async function readyCompanyWithData(u: TestUser, name: string) {
  const c = await createCompany(u, name);
  await onlyCompanies([c]);
  const deps = await workerDeps();
  await drain(deps);
  const up = await storeValidatedUpload(pool, { userId: u.id, companyId: c, filename: "d.csv", text: CSV, byteSize: CSV.length, now: new Date("2026-11-23T12:00:00Z") });
  expect((await u.client.rpc("queue_csv_import", { p_upload_id: up.uploadId })).error).toBeNull();
  await drain(deps);
  const r = (await pool.query(`select * from public.analytics_resources where company_id = $1`, [c])).rows[0];
  expect(r.status).toBe("ready");
  return { c, ref: { provider: "local" as const, projectId: r.project_id, datasetId: r.dataset_id, location: r.location } };
}

describe("company deletion", () => {
  it("requires the exact company name and a workspace admin; other tenants cannot delete", async () => {
    const { c } = await readyCompanyWithData(A, "Delete Guard");
    expect((await A.client.rpc("delete_company", { p_company_id: c, p_confirm_name: "wrong" })).error?.message).toMatch(/confirmation name/);
    expect((await B.client.rpc("delete_company", { p_company_id: c, p_confirm_name: "Delete Guard" })).error?.message).toMatch(/not found/);
    const row = (await pool.query(`select status from public.companies where id = $1`, [c])).rows[0];
    expect(row.status).toBe("active");
  });

  it("drops the dataset, removes the company and its rows, keeps the audit trail", async () => {
    const { c, ref } = await readyCompanyWithData(A, "Delete Me");
    const wh = await localWarehouse();
    expect(await wh.getDatasetLabels(ref)).not.toBeNull();
    const countBefore = (await pool.query(`select dataset_count from public.cloud_projects where provider = 'local'`)).rows[0].dataset_count;

    const del = await A.client.rpc("delete_company", { p_company_id: c, p_confirm_name: " delete me " });
    expect(del.error).toBeNull();
    // Hidden from the app and no longer manageable right away.
    const visible = await A.client.from("companies").select("id").eq("id", c).eq("status", "active");
    expect(visible.data).toEqual([]);
    expect((await A.client.rpc("ensure_csv_connection", { p_company_id: c })).error).not.toBeNull();
    // Repeating the request is idempotent (same job).
    const again = await A.client.rpc("delete_company", { p_company_id: c, p_confirm_name: "" });
    expect(again.data).toBe(del.data);

    await drain(await workerDeps());

    expect(await wh.getDatasetLabels(ref)).toBeNull();
    for (const t of ["companies", "analytics_resources", "company_connections", "csv_uploads", "sync_runs", "provisioning_jobs"]) {
      const col = t === "companies" ? "id" : "company_id";
      expect((await pool.query(`select count(*)::int n from public.${t} where ${col} = $1`, [c])).rows[0].n, t).toBe(0);
    }
    const countAfter = (await pool.query(`select dataset_count from public.cloud_projects where provider = 'local'`)).rows[0].dataset_count;
    expect(countBefore - countAfter).toBe(1);
    const audit = await pool.query(`select action from public.audit_logs where company_id = $1 order by id`, [c]);
    expect(audit.rows.map((r) => r.action)).toEqual(expect.arrayContaining(["company.deletion_requested", "company.deleted"]));
  });

  it("never drops a dataset whose labels name another company", async () => {
    const { c, ref } = await readyCompanyWithData(A, "Delete Mismatch");
    // Simulate a corrupted registry: the dataset's labels point at another tenant.
    const wh = await localWarehouse();
    await (wh as unknown as { pool: { query: (q: string) => Promise<unknown> } }).pool.query(
      `update "${ref.datasetId}"._dataset_meta set value = '00000000-0000-0000-0000-000000000000' where key = 'mip_company'`,
    );
    expect((await A.client.rpc("delete_company", { p_company_id: c, p_confirm_name: "Delete Mismatch" })).error).toBeNull();
    await drain(await workerDeps());
    expect(await wh.getDatasetLabels(ref)).not.toBeNull();
    const job = (await pool.query(`select status, last_error_code from public.provisioning_jobs where company_id = $1 and kind = 'delete_dataset'`, [c])).rows[0];
    expect(job).toMatchObject({ status: "failed", last_error_code: "dataset_owner_mismatch" });
    expect((await pool.query(`select status from public.companies where id = $1`, [c])).rows[0].status).toBe("deleting");
  });
});
