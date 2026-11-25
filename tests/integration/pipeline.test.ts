import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { encryptSecret } from "@/server/crypto";
import { storeValidatedUpload } from "@/server/ingestion/uploads";
import { getDashboardData } from "@/server/metrics/dashboard";
import { SimulatedConnector } from "@/server/connectors/simulated";
import { ConnectorError, type Connector } from "@/server/connectors/types";
import { validateCsv } from "@/server/ingestion/csv";
import { drain, runMaintenanceOnce, runSyncOnce } from "@/worker/worker";
import { createCompany, createVerifiedUser, localWarehouse, makeQueuedRunnable, onlyCompanies, pool, type TestUser, workerDeps } from "./helpers";

let A: TestUser;
let B: TestUser;
let ca: string;
let cb: string;
const sample = readFileSync("public/sample-marketing-data.csv", "utf8");

beforeAll(async () => {
  A = await createVerifiedUser("pipeA");
  B = await createVerifiedUser("pipeB");
  ca = await createCompany(A, "Pipe A");
  cb = await createCompany(B, "Pipe B", "America/Los_Angeles");
  await onlyCompanies([ca, cb]);
  await drain(await workerDeps());
});
afterAll(async () => {
  await pool.end();
});

async function importCsv(u: TestUser, companyId: string, text: string, now = new Date("2026-11-23T12:00:00Z")) {
  const up = await storeValidatedUpload(pool, { userId: u.id, companyId, filename: "data.csv", text, byteSize: Buffer.byteLength(text), now });
  expect(up.validation.errors).toEqual([]);
  const q = await u.client.rpc("queue_csv_import", { p_upload_id: up.uploadId });
  expect(q.error).toBeNull();
  return { uploadId: up.uploadId!, runId: q.data as string, duplicateOf: up.duplicateOf };
}

describe("CSV import end to end", () => {
  it("validated CSV → RAW → NORMALIZED → MART → dashboard KPIs equal the file totals", async () => {
    const deps = await workerDeps();
    const { runId } = await importCsv(A, ca, sample);
    await drain(deps);
    const run = (await pool.query(`select status, rows_written from public.sync_runs where id = $1`, [runId])).rows[0];
    expect(run.status).toBe("succeeded");
    const expected = validateCsv(sample, { today: "2026-11-22" }).summary.totals;
    const d = await getDashboardData(pool, deps.getWarehouse, A.id, ca, { from: "2026-10-01", to: "2026-10-31" });
    expect(d.status).toBe("ready");
    expect(d.isSimulatedWarehouse).toBe(true);
    expect(d.current!.blended.totals.spendByCurrency.USD).toBeCloseTo(expected.spend!, 2);
    expect(d.current!.blended.totals.impressions).toBe(expected.impressions);
    expect(d.current!.blended.totals.clicks).toBe(expected.clicks);
    expect(d.current!.blended.totals.sessions).toBe(expected.sessions);
    const meta = d.current!.bySource.find((s) => s.source === "meta_ads")!;
    expect(meta.conversionType).toBe("csv_conversion");
    expect(meta.kpis.cpl.status).toBe("ok");
    const crm = d.current!.bySource.find((s) => s.source === "crm")!;
    expect(crm.totals.billedRevenueByCurrency.USD).toBeGreaterThan(0);
    expect(crm.totals.attributedRevenueByCurrency).toEqual({});
    expect(d.current!.hasSimulated).toBe(false); // uploaded data is real data, not sample data
    expect(d.campaigns.length).toBeGreaterThan(3);
    const conn = await A.client.from("company_connections").select("provider_id,status,data_as_of").eq("company_id", ca);
    expect(conn.data).toEqual([{ provider_id: "csv", status: "connected", data_as_of: "2026-10-31" }]);
  });

  it("re-importing the same file is idempotent (same upload, same run, no double counting)", async () => {
    const deps = await workerDeps();
    const again = await importCsv(A, ca, sample);
    expect(again.duplicateOf).not.toBeNull();
    await drain(deps);
    const d = await getDashboardData(pool, deps.getWarehouse, A.id, ca, { from: "2026-10-01", to: "2026-10-31" });
    const expected = validateCsv(sample, { today: "2026-11-22" }).summary.totals;
    expect(d.current!.blended.totals.clicks).toBe(expected.clicks);
    const runs = await pool.query(`select count(*)::int n from public.sync_runs where company_id = $1 and provider_id = 'csv'`, [ca]);
    expect(runs.rows[0].n).toBe(1);
  });

  it("a corrected file overwrites the same grain (dedup) instead of adding to it", async () => {
    const deps = await workerDeps();
    const corrected = "date,source,account_id,campaign_id,campaign_name,currency,spend,impressions,clicks\n2026-10-01,meta_ads,demo-meta,m-101,Synthetic - AC Repair Leads,USD,1000.00,5000,100\n";
    const before = await getDashboardData(pool, deps.getWarehouse, A.id, ca, { from: "2026-10-01", to: "2026-10-01" });
    await importCsv(A, ca, corrected);
    await drain(deps);
    const after = await getDashboardData(pool, deps.getWarehouse, A.id, ca, { from: "2026-10-01", to: "2026-10-01" });
    const m101Before = before.campaigns.find((x) => x.campaign_id === "m-101")!;
    const m101After = after.campaigns.find((x) => x.campaign_id === "m-101")!;
    expect(m101Before.spend).not.toBe(1000);
    expect(m101After.spend).toBe(1000);
    expect(m101After.clicks).toBe(100);
    expect(m101After.conversions).toBeNull(); // column absent in corrected file → not available
    const raw = await pool.query(`select count(*)::int n from public.sync_runs where company_id = $1 and provider_id='csv' and status='succeeded'`, [ca]);
    expect(raw.rows[0].n).toBe(2); // RAW keeps both imports (provenance)
  });

  it("data stays isolated: company B's dataset has none of A's rows", async () => {
    const deps = await workerDeps();
    const d = await getDashboardData(pool, deps.getWarehouse, B.id, cb, { from: "2026-10-01", to: "2026-10-31" });
    expect(d.status).toBe("ready");
    expect(d.current!.rowCount).toBe(0);
    expect(d.campaigns).toEqual([]);
    const wh = await localWarehouse();
    const ra = (await pool.query(`select dataset_id from public.analytics_resources where company_id = $1`, [ca])).rows[0].dataset_id;
    const rb = (await pool.query(`select dataset_id from public.analytics_resources where company_id = $1`, [cb])).rows[0].dataset_id;
    expect(ra).not.toBe(rb);
    expect(await wh.coveredDates({ provider: "local", projectId: "local", datasetId: rb, location: "local" }, "csv", { from: "2026-10-01", to: "2026-10-31" })).toEqual([]);
  });

  it("invalid files are rejected before anything is stored", async () => {
    const up = await storeValidatedUpload(pool, { userId: A.id, companyId: ca, filename: "bad.csv", text: "date,source,campaign_name,spend\nnot-a-date,x,y,5\n", byteSize: 50 });
    expect(up.uploadId).toBeNull();
    expect(up.validation.errors[0]!.column).toBe("date");
  });
});

describe("scheduled sync with checkpoints, late arrivals and recovery (simulated Google Ads)", () => {
  let conn: string;
  let current = new Date("2026-11-23T20:00:00Z");
  const now = () => current;

  it("enabling the sample connector creates a daily schedule; the central scheduler enqueues it", async () => {
    const r = await B.client.rpc("enable_simulated_connection", { p_company_id: cb, p_provider_id: "google_ads" });
    expect(r.error).toBeNull();
    conn = r.data as string;
    const sched = await B.client.from("sync_schedules").select("frequency,timezone,local_time,enabled").eq("connection_id", conn);
    expect(sched.data).toEqual([{ frequency: "daily", timezone: "America/Los_Angeles", local_time: "06:00:00", enabled: true }]);
    await pool.query(`update public.sync_schedules set next_run_at = $2 where connection_id = $1`, [conn, new Date(current.getTime() - 1000)]);
    const deps = await workerDeps({ now });
    const m = await runMaintenanceOnce(deps);
    expect(m.enqueued).toBe(1);
    const again = await runMaintenanceOnce(deps);
    expect(again.enqueued).toBe(0); // idempotent; next_run_at moved forward
    const next = (await pool.query(`select next_run_at from public.sync_schedules where connection_id = $1`, [conn])).rows[0].next_run_at;
    expect(new Date(next).getTime()).toBeGreaterThan(current.getTime());
  });

  it("first sync backfills complete days in the company timezone and sets the cursor", async () => {
    const deps = await workerDeps({ now });
    expect(await runSyncOnce(deps)).toBe("succeeded");
    const cp = (await pool.query(`select cursor_date from public.sync_checkpoints where connection_id = $1`, [conn])).rows[0];
    expect(cp.cursor_date).toBe("2026-11-22"); // 12:00 LA on the 23rd → yesterday = 22nd
    const run = (await pool.query(`select window_start, window_end, is_simulated from public.sync_runs where connection_id = $1`, [conn])).rows[0];
    expect(run).toEqual({ window_start: "2026-10-24", window_end: "2026-11-22", is_simulated: true });
    const d = await getDashboardData(pool, deps.getWarehouse, B.id, cb, { from: "2026-11-01", to: "2026-11-22" });
    expect(d.current!.hasSimulated).toBe(true);
    expect(d.current!.hasPreliminary).toBe(true);
    const ads = d.current!.bySource.find((s) => s.origin === "google_ads")!;
    expect(ads.isSimulated).toBe(true);
    expect(ads.conversionType).toBe("ad_platform_conversion");
    expect(ads.kpis.ctr.status).toBe("ok");
  });

  it("next day's incremental sync re-fetches the lookback window and corrects late-arriving conversions", async () => {
    const deps0 = await workerDeps({ now });
    const before = await getDashboardData(pool, deps0.getWarehouse, B.id, cb, { from: "2026-11-21", to: "2026-11-21" });
    current = new Date("2026-11-24T20:00:00Z");
    const deps = await workerDeps({ now });
    expect((await B.client.rpc("request_sync", { p_connection_id: conn })).error).toBeNull();
    expect(await runSyncOnce(deps)).toBe("succeeded");
    const run = (await pool.query(`select window_start, window_end from public.sync_runs where connection_id = $1 order by created_at desc limit 1`, [conn])).rows[0];
    expect(run).toEqual({ window_start: "2026-11-10", window_end: "2026-11-23" }); // 14-day lookback ending new yesterday
    const after = await getDashboardData(pool, deps.getWarehouse, B.id, cb, { from: "2026-11-21", to: "2026-11-21" });
    const conv = (s: typeof before) => s.current!.bySource.find((x) => x.origin === "google_ads")!.totals.conversions!;
    expect(conv(after)).toBeGreaterThan(conv(before)); // late conversions arrived, not double counted
    const cp = (await pool.query(`select cursor_date from public.sync_checkpoints where connection_id = $1`, [conn])).rows[0];
    expect(cp.cursor_date).toBe("2026-11-23");
  });

  it("rate limiting is retried with backoff; the cursor only advances after success", async () => {
    let calls = 0;
    const failing: Connector = new SimulatedConnector("google_ads", { code: "rate_limited", times: 1 });
    const deps = await workerDeps({ now, syncOverrides: { connectorOverride: () => { calls++; return failing; } } });
    current = new Date("2026-11-25T20:00:00Z");
    await B.client.rpc("request_sync", { p_connection_id: conn });
    expect(await runSyncOnce(deps)).toBe("failed");
    let run = (await pool.query(`select status, error_code, attempts from public.sync_runs where connection_id = $1 order by created_at desc limit 1`, [conn])).rows[0];
    expect(run).toMatchObject({ status: "queued", error_code: "rate_limited", attempts: 1 });
    expect((await pool.query(`select cursor_date from public.sync_checkpoints where connection_id = $1`, [conn])).rows[0].cursor_date).toBe("2026-11-23");
    await makeQueuedRunnable();
    expect(await runSyncOnce(deps)).toBe("succeeded");
    run = (await pool.query(`select status, attempts from public.sync_runs where connection_id = $1 order by created_at desc limit 1`, [conn])).rows[0];
    expect(run).toMatchObject({ status: "succeeded", attempts: 2 });
    expect(calls).toBe(2);
    expect((await pool.query(`select cursor_date from public.sync_checkpoints where connection_id = $1`, [conn])).rows[0].cursor_date).toBe("2026-11-24");
  });

  it("incomplete provider results fail the run instead of being accepted as complete", async () => {
    const partial: Connector = {
      ...new SimulatedConnector("google_ads"),
      providerId: "google_ads", origin: "google_ads", mode: "simulated", requiredScopes: [], finalizationDays: 14, lookbackDays: 14,
      fetchDaily: async () => ({ records: [], apiCalls: 1, complete: false, notes: ["page limit"] }),
    };
    const deps = await workerDeps({ now, syncOverrides: { connectorOverride: () => partial } });
    await B.client.rpc("request_sync", { p_connection_id: conn });
    expect(await runSyncOnce(deps)).toBe("failed");
    const run = (await pool.query(`select status, error_code from public.sync_runs where connection_id = $1 order by created_at desc limit 1`, [conn])).rows[0];
    expect(run).toMatchObject({ status: "queued", error_code: "incomplete_data" });
    await pool.query(`update public.sync_runs set status = 'cancelled' where connection_id = $1 and status = 'queued'`, [conn]);
  });

  it("missing days in a window are reported as data-quality info, not filled in", async () => {
    const gappy: Connector = Object.assign(Object.create(SimulatedConnector.prototype), new SimulatedConnector("google_ads"));
    const orig = gappy.fetchDaily.bind(gappy);
    gappy.fetchDaily = async (c) => {
      const r = await orig(c);
      return { ...r, records: r.records.filter((x) => x.date !== "2026-10-05") };
    };
    const deps = await workerDeps({ now, syncOverrides: { connectorOverride: () => gappy } });
    await B.client.rpc("request_sync", { p_connection_id: conn, p_window_start: "2026-10-01", p_window_end: "2026-10-07" });
    await pool.query(`delete from public.data_quality_issues where connection_id = $1`, [conn]);
    // remove previously synced rows for the gap day so the gap is visible
    const ds = (await pool.query(`select dataset_id from public.analytics_resources where company_id = $1`, [cb])).rows[0].dataset_id;
    const wh = await localWarehouse();
    await (wh as unknown as { pool: { query: (s: string) => Promise<unknown> } }).pool.query(`delete from "${ds}".norm_campaign_daily where metric_date = '2026-10-05'`);
    expect(await runSyncOnce(deps)).toBe("succeeded");
    const issues = await B.client.from("data_quality_issues").select("code,details").eq("connection_id", conn);
    const gap = issues.data!.find((i) => i.code === "no_rows_for_dates")!;
    expect(gap.details.dates).toEqual(["2026-10-05"]);
  });

  it("a re-sync replaces the window: campaigns the provider no longer returns do not linger", async () => {
    const shrinking: Connector = Object.assign(Object.create(SimulatedConnector.prototype), new SimulatedConnector("google_ads"));
    const orig = shrinking.fetchDaily.bind(shrinking);
    shrinking.fetchDaily = async (c) => {
      const r = await orig(c);
      const first = r.records[0]!.campaign_id;
      return { ...r, records: r.records.filter((x) => x.campaign_id === first) };
    };
    const deps = await workerDeps({ now, syncOverrides: { connectorOverride: () => shrinking } });
    const ds = (await pool.query(`select * from public.analytics_resources where company_id = $1`, [cb])).rows[0];
    const ref = { provider: "local" as const, projectId: ds.project_id, datasetId: ds.dataset_id, location: ds.location };
    const wh = await localWarehouse();
    const range = { from: "2026-10-01", to: "2026-10-03" };
    const before = await wh.queryCampaigns(ref, range, 100);
    expect(before.rows.filter((r) => r.origin === "google_ads").length).toBeGreaterThan(1);
    await B.client.rpc("request_sync", { p_connection_id: conn, p_window_start: range.from, p_window_end: range.to });
    expect(await runSyncOnce(deps)).toBe("succeeded");
    const after = await wh.queryCampaigns(ref, range, 100);
    expect(after.rows.filter((r) => r.origin === "google_ads").length).toBe(1);
    // The raw table holds exactly one copy per day and campaign after repeated syncs.
    const rawPool = (wh as unknown as { pool: { query: (q: string, p?: unknown[]) => Promise<{ rows: { n: number; d: number }[] }> } }).pool;
    await B.client.rpc("request_sync", { p_connection_id: conn, p_window_start: range.from, p_window_end: range.to });
    expect(await runSyncOnce(deps)).toBe("succeeded");
    const rawCounts = (await rawPool.query(
      `select count(*)::int n, count(distinct record_date)::int d
         from "${ds.dataset_id}".raw_records where origin = 'google_ads' and record_date between $1 and $2`,
      [range.from, range.to],
    )).rows[0]!;
    expect(rawCounts.n).toBe(3);
    expect(rawCounts.d).toBe(3);
    // Days outside the window are untouched.
    const outside = await wh.queryCampaigns(ref, { from: "2026-10-06", to: "2026-10-07" }, 100);
    expect(outside.rows.filter((r) => r.origin === "google_ads").length).toBeGreaterThan(1);
  });

  it("expired credentials mark a live connection 'expired' and stop retrying", async () => {
    const live = await pool.query<{ id: string }>(
      `insert into public.company_connections (workspace_id, company_id, provider_id, mode, status, external_account_id)
       values ($1, $2, 'ga4', 'live', 'connected', '123456') returning id`,
      [B.workspaceId, cb],
    );
    const liveId = live.rows[0]!.id;
    const deps = await workerDeps({ now });
    await pool.query(`insert into public.connection_secrets (connection_id, workspace_id, company_id, ciphertext) values ($1, $2, $3, $4)`, [
      liveId, B.workspaceId, cb, encryptSecret("1//expired", deps.cfg.tokenEncryptionKey!, liveId),
    ]);
    const expired: Connector = { ...new SimulatedConnector("ga4"), providerId: "ga4", origin: "ga4", mode: "live", requiredScopes: [], finalizationDays: 3, lookbackDays: 3,
      fetchDaily: async () => { throw new ConnectorError("auth_expired", "invalid_grant"); } };
    const deps2 = await workerDeps({ now, syncOverrides: { connectorOverride: () => expired } });
    await B.client.rpc("request_sync", { p_connection_id: liveId });
    expect(await runSyncOnce(deps2)).toBe("failed");
    const c = await B.client.from("company_connections").select("status,last_error").eq("id", liveId);
    expect(c.data![0]!.status).toBe("expired");
    const run = (await pool.query(`select status from public.sync_runs where connection_id = $1`, [liveId])).rows[0];
    expect(run.status).toBe("failed"); // not retried: needs the user to reconnect
    const secrets = (await B.client.from("connection_secrets").select("*"));
    expect(secrets.error).not.toBeNull();
  });

  it("disconnect stops schedules, deletes stored credentials, keeps warehouse data", async () => {
    const deps = await workerDeps({ now });
    const before = await getDashboardData(pool, deps.getWarehouse, B.id, cb, { from: "2026-11-01", to: "2026-11-22" });
    expect((await B.client.rpc("disconnect_connection", { p_connection_id: conn })).error).toBeNull();
    const s = await B.client.from("sync_schedules").select("enabled").eq("connection_id", conn);
    expect(s.data).toEqual([{ enabled: false }]);
    const after = await getDashboardData(pool, deps.getWarehouse, B.id, cb, { from: "2026-11-01", to: "2026-11-22" });
    expect(after.current!.rowCount).toBe(before.current!.rowCount);
    expect((await B.client.rpc("request_sync", { p_connection_id: conn })).error?.message).toMatch(/disconnected/);
  });
});

describe("usage instrumentation", () => {
  it("records job runs, rows written and dashboard queries per workspace (estimates flagged)", async () => {
    const u = await A.client.from("usage_events").select("kind,is_estimate").eq("workspace_id", A.workspaceId);
    const kinds = new Set(u.data!.map((x) => x.kind));
    expect(kinds).toEqual(new Set(["job_run", "warehouse_rows_written", "warehouse_query"]));
    expect(u.data!.every((x) => x.is_estimate)).toBe(true);
    const other = await B.client.from("usage_events").select("id").eq("workspace_id", A.workspaceId);
    expect(other.data).toEqual([]);
  });
});
