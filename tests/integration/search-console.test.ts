import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { loadConnection, loadRawPage, setGa4Groups } from "@/server/connections/manage";
import { SearchConsoleConnector } from "@/server/connectors/searchConsole";
import { parseRawTableParams } from "@/lib/rawTable";
import { encryptSecret } from "@/server/crypto";
import { drain, runSyncOnce } from "@/worker/worker";
import { createCompany, createVerifiedUser, localWarehouse, onlyCompanies, pool, type TestUser, workerDeps } from "./helpers";

let U: TestUser;
let company: string;
let conn: string;
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

// Fake Search Console: day totals 100 clicks; split by query only 60 (Google hides rare queries).
const fakeFetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
  if (String(url).startsWith("https://oauth2.googleapis.com/token")) return json({ access_token: "t" });
  const body = JSON.parse(String(init?.body));
  const days = ["2026-11-01", "2026-11-02"];
  if (body.dimensions.length === 1) return json({ rows: days.map((d) => ({ keys: [d], clicks: 100, impressions: 1000, ctr: 0.1, position: 5 })) });
  return json({ rows: days.flatMap((d) => [
    { keys: [d, "ac repair"], clicks: 40, impressions: 400, ctr: 0.1, position: 3 },
    { keys: [d, "hvac"], clicks: 20, impressions: 300, ctr: 0.07, position: 7 },
  ]) });
});

beforeAll(async () => {
  U = await createVerifiedUser("gsc");
  company = await createCompany(U, "Search Console Co");
  await onlyCompanies([company]);
  await drain(await workerDeps());
  conn = (await pool.query(
    `insert into public.company_connections (workspace_id, company_id, provider_id, mode, status, external_account_id, external_account_name)
     values ($1, $2, 'google_search_console', 'live', 'connected', 'sc-domain:example.com', 'example.com') returning id`,
    [U.workspaceId, company],
  )).rows[0].id;
  const deps = await workerDeps();
  await pool.query(`insert into public.connection_secrets (connection_id, workspace_id, company_id, ciphertext) values ($1, $2, $3, $4)`, [conn, U.workspaceId, company, encryptSecret("1//rt", deps.cfg.tokenEncryptionKey!, conn)]);
});
afterAll(async () => {
  await pool.end();
});

describe("Search Console connector", () => {
  it("columns are chosen like GA4; the table shows them, the dashboard counts every click", async () => {
    const deps = await workerDeps({ syncOverrides: { connectorOverride: () => new SearchConsoleConnector({ clientId: "id", clientSecret: "s", fetch: fakeFetch as never }) } });
    expect(await setGa4Groups(pool, deps.getWarehouse, U.id, conn, ["queries"])).toMatchObject({ changed: true, added: ["query"] });
    expect((await loadConnection(pool, U.id, conn))!.settings.columns).toEqual(["query"]);
    await pool.query(
      `insert into public.sync_runs (workspace_id, company_id, connection_id, provider_id, trigger, idempotency_key, window_start, window_end)
       values ($1, $2, $3, 'google_search_console', 'manual', gen_random_uuid()::text, '2026-11-01', '2026-11-02')`,
      [U.workspaceId, company, conn],
    );
    expect(await runSyncOnce(deps)).toBe("succeeded");

    const page = await loadRawPage(pool, deps.getWarehouse, U.id, conn, parseRawTableParams({ period: "all" }, "2026-11-24"), { limit: 50, offset: 0 });
    expect(page.columns.map((c) => c.label)).toEqual(["query", "clicks", "impressions", "ctr", "position"]);
    expect(page.total).toBe(4);
    const r = (await pool.query(`select * from public.analytics_resources where company_id = $1`, [company])).rows[0];
    const ref = { provider: "local" as const, projectId: r.project_id, datasetId: r.dataset_id, location: r.location };
    const daily = (await (await localWarehouse()).queryDaily(ref, { from: "2026-11-01", to: "2026-11-02" })).rows;
    expect(daily.map((d) => [d.origin, d.clicks])).toEqual([["google_search_console", 100], ["google_search_console", 100]]);
  });
});
