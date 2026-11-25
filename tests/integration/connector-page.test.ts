import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { storeValidatedUpload } from "@/server/ingestion/uploads";
import { deleteConnection, loadConnection, loadRawRows, updateSchedule } from "@/server/connections/manage";
import { drain } from "@/worker/worker";
import { createCompany, createVerifiedUser, localWarehouse, onlyCompanies, pool, type TestUser, workerDeps } from "./helpers";

let A: TestUser;
let B: TestUser;
let company: string;
const CSV = "date,source,campaign_name,currency,spend,clicks\n2026-11-01,meta_ads,Brand,USD,10.50,7\n2026-11-02,meta_ads,Brand,USD,4.00,3\n";
const range = { from: "2026-10-01", to: "2026-11-30" };

beforeAll(async () => {
  A = await createVerifiedUser("connA");
  B = await createVerifiedUser("connB");
  company = await createCompany(A, "Connector Co");
  await onlyCompanies([company]);
  const deps = await workerDeps();
  await drain(deps);
  const up = await storeValidatedUpload(pool, { userId: A.id, companyId: company, filename: "d.csv", text: CSV, byteSize: CSV.length, now: new Date("2026-11-23T12:00:00Z") });
  expect((await A.client.rpc("queue_csv_import", { p_upload_id: up.uploadId })).error).toBeNull();
  expect((await A.client.rpc("enable_simulated_connection", { p_company_id: company, p_provider_id: "ga4" })).error).toBeNull();
  await drain(deps);
});
afterAll(async () => {
  await pool.end();
});

async function conn(provider: string) {
  return (await pool.query(`select id from public.company_connections where company_id = $1 and provider_id = $2`, [company, provider])).rows[0]!.id as string;
}
async function ref() {
  const r = (await pool.query(`select * from public.analytics_resources where company_id = $1`, [company])).rows[0];
  return { provider: "local" as const, projectId: r.project_id, datasetId: r.dataset_id, location: r.location };
}

describe("connector page", () => {
  it("only members of the company can open a connector", async () => {
    const id = await conn("csv");
    expect(await loadConnection(pool, A.id, id)).toMatchObject({ provider_id: "csv", access: "manage" });
    expect(await loadConnection(pool, B.id, id)).toBeNull();
    await expect(updateSchedule(pool, B.id, await conn("ga4"), { frequency: "manual", localTime: "07:00" })).rejects.toThrow();
  });

  it("shows the raw rows a connector imported", async () => {
    const deps = await workerDeps();
    const raw = await loadRawRows(pool, deps.getWarehouse, A.id, await conn("csv"));
    expect(raw.available).toBe(true);
    expect(raw.rows.map((r) => r.record_date).sort()).toEqual(["2026-11-01", "2026-11-02"]);
    expect(JSON.parse(raw.rows[0]!.payload_json)).toHaveProperty("campaign_name", "Brand");
  });

  it("changes the daily time or switches to manual only", async () => {
    const id = await conn("ga4");
    await updateSchedule(pool, A.id, id, { frequency: "daily", localTime: "09:30" }, new Date("2026-11-24T12:00:00Z"));
    let s = (await pool.query(`select frequency, to_char(local_time, 'HH24:MI') t, enabled, next_run_at from public.sync_schedules where connection_id = $1`, [id])).rows[0];
    expect(s).toMatchObject({ frequency: "daily", t: "09:30", enabled: true });
    expect(new Date(s.next_run_at).getTime()).toBeGreaterThan(new Date("2026-11-24T12:00:00Z").getTime());
    await updateSchedule(pool, A.id, id, { frequency: "manual", localTime: "09:30" });
    s = (await pool.query(`select frequency, enabled, next_run_at from public.sync_schedules where connection_id = $1`, [id])).rows[0];
    expect(s).toMatchObject({ frequency: "manual", enabled: false, next_run_at: null });
    await expect(updateSchedule(pool, A.id, id, { frequency: "daily", localTime: "25:00" })).rejects.toThrow(/invalid time/);
  });

  it("deleting a connector removes only its data and rebuilds the dashboard numbers", async () => {
    const deps = await workerDeps();
    const wh = await localWarehouse();
    const before = (await wh.queryDaily(await ref(), range)).rows;
    expect(before.some((r) => r.origin === "ga4" && r.is_simulated)).toBe(true);
    expect(before.some((r) => r.origin === "csv")).toBe(true);

    const id = await conn("ga4");
    await expect(deleteConnection(pool, deps.getWarehouse, B.id, id)).rejects.toThrow();
    await deleteConnection(pool, deps.getWarehouse, A.id, id);

    const after = (await wh.queryDaily(await ref(), range)).rows;
    expect(after.some((r) => r.origin === "ga4")).toBe(false);
    expect(after.filter((r) => r.origin === "csv")).toEqual(before.filter((r) => r.origin === "csv"));
    expect((await pool.query(`select count(*)::int n from public.company_connections where id = $1`, [id])).rows[0].n).toBe(0);
    expect((await pool.query(`select count(*)::int n from public.sync_runs where connection_id = $1`, [id])).rows[0].n).toBe(0);
  });
});
