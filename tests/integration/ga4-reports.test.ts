import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { clearConnectorForReload, loadConnection, loadRawPage, setGa4Report } from "@/server/connections/manage";
import type { Connector, FetchContext } from "@/server/connectors/types";
import { ga4Fields } from "@/lib/ga4Catalog";
import { parseRawTableParams } from "@/lib/rawTable";
import { encryptSecret } from "@/server/crypto";
import { drain, runSyncOnce } from "@/worker/worker";
import { createCompany, createVerifiedUser, localWarehouse, onlyCompanies, pool, type TestUser, workerDeps } from "./helpers";

let U: TestUser;
let company: string;
let conn: string;

// Fake live GA4: one campaign per day, split by source when "traffic_sources" is on (google 17 + bing 1).
const fakeGa4: Connector = {
  providerId: "ga4", origin: "ga4", mode: "live", requiredScopes: [], finalizationDays: 3, lookbackDays: 3,
  async fetchDaily(c: FetchContext) {
    const fields = ga4Fields(c.options?.ga4Reports);
    const split = fields.dimensions.includes("sessionSource");
    const records = [];
    for (let d = new Date(c.window.from + "T00:00:00Z"); d <= new Date(c.window.to + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + 1)) {
      const date = d.toISOString().slice(0, 10);
      const parts = split ? [["google", 17], ["bing", 1]] : [[null, 18]];
      for (const [source, sessions] of parts) {
        const raw: Record<string, string> = { date: date.replace(/-/g, ""), sessionCampaignId: "(not set)", sessionCampaignName: "(organic)", sessions: String(sessions), keyEvents: "1", totalRevenue: "0" };
        if (source) Object.assign(raw, { sessionSource: String(source), sessionMedium: "organic", sessionDefaultChannelGroup: "Organic Search" });
        records.push({
          date, account_id: c.externalAccountId, account_name: null, campaign_id: "(not set) (organic)", campaign_name: "(organic)", currency: "USD", timezone: "UTC",
          metrics: { impressions: null, clicks: null, spend: null, sessions: Number(sessions), conversions: 1, conversion_type: "ga4_key_event" as const, leads: null, attributed_revenue: 0, billed_revenue: null },
          raw, rawKey: fields.dimensions.map((k) => raw[k] ?? "").join("|"),
        });
      }
    }
    return { records, apiCalls: 1, complete: true, notes: [] };
  },
};

beforeAll(async () => {
  U = await createVerifiedUser("ga4one");
  company = await createCompany(U, "GA4 One Table Co");
  await onlyCompanies([company]);
  await drain(await workerDeps());
  conn = (await pool.query(
    `insert into public.company_connections (workspace_id, company_id, provider_id, mode, status, external_account_id) values ($1, $2, 'ga4', 'live', 'connected', '555') returning id`,
    [U.workspaceId, company],
  )).rows[0].id;
  const deps = await workerDeps();
  await pool.query(`insert into public.connection_secrets (connection_id, workspace_id, company_id, ciphertext) values ($1, $2, $3, $4)`, [conn, U.workspaceId, company, encryptSecret("1//rt", deps.cfg.tokenEncryptionKey!, conn)]);
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
const all = parseRawTableParams({ period: "all" }, "2026-11-24");

describe("GA4 one table", () => {
  it("a switched-on group adds its columns to the same table; the dashboard still counts each visit once", async () => {
    const deps = await workerDeps({ syncOverrides: { connectorOverride: () => fakeGa4 } });
    await setGa4Report(pool, deps.getWarehouse, U.id, conn, "traffic_sources", true);
    expect((await loadConnection(pool, U.id, conn))!.settings.ga4_reports).toEqual(["traffic_sources"]);
    expect(await sync(deps)).toBe("succeeded");
    expect(await sync(deps)).toBe("succeeded"); // a repeated load replaces, never duplicates

    const page = await loadRawPage(pool, deps.getWarehouse, U.id, conn, all, { source: "ga4", limit: 100, offset: 0 });
    expect(page.columns.map((c) => c.label)).toContain("sessionSource");
    expect(page.total).toBe(6); // 3 days × google/bing
    const r = (await pool.query(`select * from public.analytics_resources where company_id = $1`, [company])).rows[0];
    const ref = { provider: "local" as const, projectId: r.project_id, datasetId: r.dataset_id, location: r.location };
    const daily = (await (await localWarehouse()).queryDaily(ref, { from: "2026-11-01", to: "2026-11-03" })).rows;
    expect(daily.map((d) => d.sessions)).toEqual([18, 18, 18]); // 17 + 1, summed back per day
    expect(await (await localWarehouse()).removeDuplicates(ref, { from: "2026-11-01", to: "2026-11-03" })).toEqual({ raw: 0, normalized: 0 });
  });

  it("the GA4 limit of 9 breakdowns is enforced before anything changes", async () => {
    const deps = await workerDeps();
    await setGa4Report(pool, deps.getWarehouse, U.id, conn, "devices", true); // 3 + 3 + 3 = 9
    await expect(setGa4Report(pool, deps.getWarehouse, U.id, conn, "landing_pages", true)).rejects.toThrow(/at most 9 breakdowns/);
    expect((await loadConnection(pool, U.id, conn))!.settings.ga4_reports).toEqual(["traffic_sources", "devices"]);
    await setGa4Report(pool, deps.getWarehouse, U.id, conn, "devices", false);
  });

  it("a change after the first load deletes all of the connector's data and reloads only the last 30 days", async () => {
    const deps = await workerDeps({ syncOverrides: { connectorOverride: () => fakeGa4 } });
    const period = await clearConnectorForReload(pool, deps.getWarehouse, U.id, conn, "2026-11-24");
    expect(period).toEqual({ from: "2026-10-26", to: "2026-11-24" });
    expect((await loadRawPage(pool, deps.getWarehouse, U.id, conn, all, { source: "ga4", limit: 10, offset: 0 })).total).toBe(0);
  });
});
