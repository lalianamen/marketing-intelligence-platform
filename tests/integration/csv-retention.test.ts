import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { storeValidatedUpload } from "@/server/ingestion/uploads";
import { drain } from "@/worker/worker";
import { createCompany, createVerifiedUser, localWarehouse, onlyCompanies, pool, type TestUser, workerDeps } from "./helpers";

let U: TestUser;
let company: string;
const CSV = "date,source,campaign_name,currency,spend,clicks\n2026-11-01,meta_ads,Brand,USD,10.50,7\n";

beforeAll(async () => {
  U = await createVerifiedUser("csvret");
  company = await createCompany(U, "CSV Retention");
  await onlyCompanies([company]);
  await drain(await workerDeps());
});
afterAll(async () => {
  await pool.end();
});

async function upload() {
  const up = await storeValidatedUpload(pool, { userId: U.id, companyId: company, filename: "d.csv", text: CSV, byteSize: CSV.length, now: new Date("2026-11-23T12:00:00Z") });
  expect((await U.client.rpc("queue_csv_import", { p_upload_id: up.uploadId })).error).toBeNull();
  await drain(await workerDeps());
  return up.uploadId!;
}

describe("CSV rows are not kept in the app database", () => {
  it("drops the rows once imported; the numbers stay in the warehouse", async () => {
    const id = await upload();
    const row = (await pool.query(`select status, jsonb_array_length(rows) n, row_count from public.csv_uploads where id = $1`, [id])).rows[0];
    expect(row).toMatchObject({ status: "imported", n: 0, row_count: 1 });
    const r = (await pool.query(`select * from public.analytics_resources where company_id = $1`, [company])).rows[0];
    const wh = await localWarehouse();
    const daily = await wh.queryDaily({ provider: "local", projectId: r.project_id, datasetId: r.dataset_id, location: r.location }, { from: "2026-11-01", to: "2026-11-01" });
    expect(daily.rows.length).toBe(1);
  });

  it("uploading the same file again is recognised and imports nothing twice", async () => {
    const up = await storeValidatedUpload(pool, { userId: U.id, companyId: company, filename: "d.csv", text: CSV, byteSize: CSV.length, now: new Date("2026-11-23T12:00:00Z") });
    expect(up.duplicateOf).toBe(up.uploadId);
    expect((await U.client.rpc("queue_csv_import", { p_upload_id: up.uploadId })).error).toBeNull();
    await drain(await workerDeps());
    const runs = (await pool.query(`select count(*)::int n from public.sync_runs where csv_upload_id = $1`, [up.uploadId])).rows[0].n;
    expect(runs).toBe(1);
  });
});
