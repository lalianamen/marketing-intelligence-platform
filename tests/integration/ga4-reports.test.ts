import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { loadConnection, loadRawRows, setGa4Report } from "@/server/connections/manage";
import type { Connector, FetchContext } from "@/server/connectors/types";
import { drain, runSyncOnce } from "@/worker/worker";
import { createCompany, createVerifiedUser, localWarehouse, onlyCompanies, pool, type TestUser, workerDeps } from "./helpers";

let U: TestUser;
let company: string;
let conn: string;
let extraFails = false;

// A fake live GA4 connector: one core row per day plus an extra "traffic_sources" row per day.
const fakeGa4: Connector = {
  providerId: "ga4", origin: "ga4", mode: "live", requiredScopes: [], finalizationDays: 3, lookbackDays: 3,
  async fetchDaily(c: FetchContext) {
    const days: string[] = [];
    for (let d = new Date(c.window.from + "T00:00:00Z"); d <= new Date(c.window.to + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + 1)) days.push(d.toISOString().slice(0, 10));
    const want = c.options?.ga4Reports ?? [];
    return {
      records: days.map((date) => ({
        date, account_id: c.externalAccountId, account_name: null, campaign_id: "(not set) (organic)", campaign_name: "(organic)", currency: "USD", timezone: "UTC",
        metrics: { impressions: null, clicks: null, spend: null, sessions: 10, conversions: 1, conversion_type: "ga4_key_event" as const, leads: null, attributed_revenue: 0, billed_revenue: null },
        raw: { date },
      })),
      apiCalls: 1, complete: true, notes: [],
      extraRaw: want.includes("traffic_sources") && !extraFails ? days.map((date) => ({ source: "ga4:traffic_sources", date, key: "google\u001forganic", payload: { date, sessionSource: "google", sessions: "9" } })) : [],
      extraFetched: want.includes("traffic_sources") && !extraFails ? ["traffic_sources"] : [],
      extraErrors: want.includes("traffic_sources") && extraFails ? [{ report: "traffic_sources", message: "quota" }] : [],
    };
  },
};

beforeAll(async () => {
  U = await createVerifiedUser("ga4rep");
  company = await createCompany(U, "GA4 Reports Co");
  await onlyCompanies([company]);
  await drain(await workerDeps());
  conn = (await pool.query(
    `insert into public.company_connections (workspace_id, company_id, provider_id, mode, status, external_account_id) values ($1, $2, 'ga4', 'live', 'connected', '555') returning id`,
    [U.workspaceId, company],
  )).rows[0].id;
  await pool.query(`insert into public.connection_secrets (connection_id, workspace_id, company_id, ciphertext) values ($1, $2, $3, 'x')`, [conn, U.workspaceId, company]);
});
afterAll(async () => {
  await pool.end();
});

async function sync(deps: Awaited<ReturnType<typeof workerDeps>>) {
  await pool.query(
    `insert into public.sync_runs (workspace_id, company_id, connection_id, provider_id, trigger, idempotency_key, window_start, window_end)
     values ($1, $2, $3, 'ga4', 'manual', gen_random_uuid()::text, '2026-11-01', '2026-11-03')`,
    [U.workspaceId, company, conn],
  );
  return runSyncOnce(deps);
}

describe("switchable GA4 reports", () => {
  it("switching a report on stores its rows as raw data, once per row, and keeps them if a later fetch fails", async () => {
    const deps = await workerDeps({ syncOverrides: { connectorOverride: () => fakeGa4 } });
    // Decryption is bypassed by the fake connector, but the sync reads the secret: give it a real ciphertext.
    const { encryptSecret } = await import("@/server/crypto");
    await pool.query(`update public.connection_secrets set ciphertext = $2 where connection_id = $1`, [conn, encryptSecret("1//rt", deps.cfg.tokenEncryptionKey!, conn)]);

    expect(await setGa4Report(pool, deps.getWarehouse, U.id, conn, "traffic_sources", true)).toEqual({ backfill: true });
    expect((await loadConnection(pool, U.id, conn))!.settings.ga4_reports).toEqual(["traffic_sources"]);
    expect(await sync(deps)).toBe("succeeded");
    expect(await sync(deps)).toBe("succeeded");
    let extra = await loadRawRows(pool, deps.getWarehouse, U.id, conn, 500, "ga4:traffic_sources");
    expect(extra.rows.map((r) => r.record_date).sort()).toEqual(["2026-11-01", "2026-11-02", "2026-11-03"]);
    const core = await loadRawRows(pool, deps.getWarehouse, U.id, conn, 500, "ga4");
    expect(core.rows).toHaveLength(3);

    extraFails = true;
    expect(await sync(deps)).toBe("succeeded"); // the core import still succeeds
    extra = await loadRawRows(pool, deps.getWarehouse, U.id, conn, 500, "ga4:traffic_sources");
    expect(extra.rows).toHaveLength(3); // previous rows kept
    const issue = (await pool.query(`select code from public.data_quality_issues where connection_id = $1 and code = 'extra_report_failed'`, [conn])).rows;
    expect(issue.length).toBeGreaterThan(0);
    extraFails = false;
  });

  it("switching a report off deletes its rows; dashboard numbers are not affected", async () => {
    const deps = await workerDeps({ syncOverrides: { connectorOverride: () => fakeGa4 } });
    const r = (await pool.query(`select * from public.analytics_resources where company_id = $1`, [company])).rows[0];
    const ref = { provider: "local" as const, projectId: r.project_id, datasetId: r.dataset_id, location: r.location };
    const wh = await localWarehouse();
    const before = (await wh.queryDaily(ref, { from: "2026-11-01", to: "2026-11-03" })).rows;
    expect(await setGa4Report(pool, deps.getWarehouse, U.id, conn, "traffic_sources", false)).toEqual({ backfill: false });
    expect((await loadRawRows(pool, deps.getWarehouse, U.id, conn, 500, "ga4:traffic_sources")).rows).toEqual([]);
    expect((await loadRawRows(pool, deps.getWarehouse, U.id, conn, 500, "ga4")).rows).toHaveLength(3);
    expect((await wh.queryDaily(ref, { from: "2026-11-01", to: "2026-11-03" })).rows).toEqual(before);
    await expect(setGa4Report(pool, deps.getWarehouse, U.id, conn, "raw_events", true)).rejects.toThrow(/unknown report/);
  });
});
