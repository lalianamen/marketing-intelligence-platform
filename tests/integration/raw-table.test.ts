import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { storeValidatedUpload } from "@/server/ingestion/uploads";
import { loadRawPage } from "@/server/connections/manage";
import { parseRawTableParams } from "@/lib/rawTable";
import { drain } from "@/worker/worker";
import { createCompany, createVerifiedUser, onlyCompanies, pool, type TestUser, workerDeps } from "./helpers";

let U: TestUser;
let other: TestUser;
let company: string;
let conn: string;
const rows = ["date,source,campaign_name,currency,spend,clicks"];
for (let d = 1; d <= 9; d++) rows.push(`2026-11-0${d},${d % 2 ? "meta_ads" : "bing_ads"},Camp ${d},USD,${d * 3}.5,${d}`);
const CSV = rows.join("\n") + "\n";

beforeAll(async () => {
  U = await createVerifiedUser("rawtab");
  other = await createVerifiedUser("rawtabx");
  company = await createCompany(U, "Raw Table Co");
  await onlyCompanies([company]);
  await drain(await workerDeps());
  const up = await storeValidatedUpload(pool, { userId: U.id, companyId: company, filename: "d.csv", text: CSV, byteSize: CSV.length, now: new Date("2026-11-23T12:00:00Z") });
  expect((await U.client.rpc("queue_csv_import", { p_upload_id: up.uploadId })).error).toBeNull();
  await drain(await workerDeps());
  conn = (await pool.query(`select id from public.company_connections where company_id = $1`, [company])).rows[0].id;
});
afterAll(async () => {
  await pool.end();
});

const yesterday = "2026-11-24";
describe("raw data table", () => {
  it("period, filters, numeric sorting and paging", async () => {
    const deps = await workerDeps();
    const p = parseRawTableParams({ period: "custom", from: "2026-11-02", to: "2026-11-08", f1c: "source", f1o: "contains", f1v: "META", f2c: "spend", f2o: "gt", f2v: "5", sort: "spend", dir: "asc" }, yesterday);
    const page = await loadRawPage(pool, deps.getWarehouse, U.id, conn, p, { limit: 2, offset: 0 });
    // meta_ads on odd days 3,5,7 within Nov 2–8 with spend > 5 → spend 9.5, 15.5, 21.5
    expect(page.total).toBe(3);
    expect(page.rows.map((r) => r.record_date)).toEqual(["2026-11-03", "2026-11-05"]);
    const next = await loadRawPage(pool, deps.getWarehouse, U.id, conn, p, { limit: 2, offset: 2 });
    expect(next.rows.map((r) => r.record_date)).toEqual(["2026-11-07"]);
    expect(page.columns.map((c) => c.label)).toContain("campaign_name");
  });

  it("full period ignores filters; other tenants get nothing", async () => {
    const deps = await workerDeps();
    const p = parseRawTableParams({ f1c: "source", f1o: "eq", f1v: "nope" }, yesterday);
    expect((await loadRawPage(pool, deps.getWarehouse, U.id, conn, p, { limit: 100, offset: 0 })).total).toBe(0);
    expect((await loadRawPage(pool, deps.getWarehouse, U.id, conn, p, { limit: 100, offset: 0, ignoreFilters: true })).total).toBe(9);
    await expect(loadRawPage(pool, deps.getWarehouse, other.id, conn, p, { limit: 100, offset: 0 })).rejects.toThrow();
  });
});
