import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { loadRawPage, setGa4Groups } from "@/server/connections/manage";
import { StripeConnector } from "@/server/connectors/stripe";
import { parseRawTableParams } from "@/lib/rawTable";
import { encryptSecret } from "@/server/crypto";
import { drain, runSyncOnce } from "@/worker/worker";
import { createCompany, createVerifiedUser, localWarehouse, onlyCompanies, pool, type TestUser, workerDeps } from "./helpers";

let U: TestUser;
let company: string;
let conn: string;
const fake = vi.fn(async () => new Response(JSON.stringify({ has_more: false, data: [
  { id: "txn_1", amount: 25000, fee: 755, net: 24245, currency: "usd", created: Date.parse("2026-11-03T18:00:00Z") / 1000, type: "charge", reporting_category: "charge", status: "available" },
  { id: "txn_2", amount: -5000, fee: 0, net: -5000, currency: "usd", created: Date.parse("2026-11-03T19:00:00Z") / 1000, type: "refund", reporting_category: "refund", status: "available" },
] }), { status: 200 }));

beforeAll(async () => {
  U = await createVerifiedUser("stripe");
  company = await createCompany(U, "Stripe Co");
  await onlyCompanies([company]);
  await drain(await workerDeps());
  conn = (await pool.query(
    `insert into public.company_connections (workspace_id, company_id, provider_id, mode, status, external_account_id, external_account_name, activated_at)
     values ($1, $2, 'stripe', 'live', 'connected', 'key-abc', 'Stripe', now()) returning id`,
    [U.workspaceId, company],
  )).rows[0].id;
  const deps = await workerDeps();
  await pool.query(`insert into public.connection_secrets (connection_id, workspace_id, company_id, ciphertext) values ($1, $2, $3, $4)`, [conn, U.workspaceId, company, encryptSecret(["rk", "live", "xxxxxxxxxxxxxxxx"].join("_"), deps.cfg.tokenEncryptionKey!, conn)]);
});
afterAll(async () => {
  await pool.end();
});

describe("Stripe connector", () => {
  it("the table shows money movements by the chosen columns; the dashboard gets billed revenue", async () => {
    const deps = await workerDeps({ syncOverrides: { connectorOverride: () => new StripeConnector({ fetch: fake as never }) } });
    await setGa4Groups(pool, deps.getWarehouse, U.id, conn, ["category"]);
    await pool.query(
      `insert into public.sync_runs (workspace_id, company_id, connection_id, provider_id, trigger, idempotency_key, window_start, window_end)
       values ($1, $2, $3, 'stripe', 'manual', gen_random_uuid()::text, '2026-11-01', '2026-11-05')`,
      [U.workspaceId, company, conn],
    );
    expect(await runSyncOnce(deps)).toBe("succeeded");
    const page = await loadRawPage(pool, deps.getWarehouse, U.id, conn, parseRawTableParams({ period: "all" }, "2026-11-24"), { limit: 50, offset: 0 });
    expect(page.columns.map((c) => c.label)).toEqual(["currency", "reporting_category", "type", "transactions", "amount", "fee", "net"]);
    expect(page.total).toBe(2);
    const r = (await pool.query(`select * from public.analytics_resources where company_id = $1`, [company])).rows[0];
    const ref = { provider: "local" as const, projectId: r.project_id, datasetId: r.dataset_id, location: r.location };
    const daily = (await (await localWarehouse()).queryDaily(ref, { from: "2026-11-01", to: "2026-11-05" })).rows;
    expect(daily.map((d) => [d.metric_date, Number(d.billed_revenue)])).toEqual([["2026-11-03", 200]]);
  });
});
