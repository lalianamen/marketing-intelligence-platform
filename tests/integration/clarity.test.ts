import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { loadRawPage, setGa4Groups } from "@/server/connections/manage";
import { ClarityConnector } from "@/server/connectors/clarity";
import { parseRawTableParams } from "@/lib/rawTable";
import { encryptSecret } from "@/server/crypto";
import { drain, runSyncOnce } from "@/worker/worker";
import { createCompany, createVerifiedUser, onlyCompanies, pool, type TestUser, workerDeps } from "./helpers";

let U: TestUser;
let company: string;
let conn: string;
const answer = [{ metricName: "Traffic", information: [
  { totalSessionCount: "12", Device: "Mobile" },
  { totalSessionCount: "8", Device: "PC" },
] }];
const fake = vi.fn(async () => new Response(JSON.stringify(answer), { status: 200 }));

beforeAll(async () => {
  U = await createVerifiedUser("clarity");
  company = await createCompany(U, "Clarity Co");
  await onlyCompanies([company]);
  await drain(await workerDeps());
  conn = (await pool.query(
    `insert into public.company_connections (workspace_id, company_id, provider_id, mode, status, external_account_id, external_account_name, activated_at)
     values ($1, $2, 'microsoft_clarity', 'live', 'connected', 'abc123xyz', 'Clarity project abc123xyz', now()) returning id`,
    [U.workspaceId, company],
  )).rows[0].id;
  const deps = await workerDeps();
  await pool.query(`insert into public.connection_secrets (connection_id, workspace_id, company_id, ciphertext) values ($1, $2, $3, $4)`, [conn, U.workspaceId, company, encryptSecret("t".repeat(30), deps.cfg.tokenEncryptionKey!, conn)]);
});
afterAll(async () => {
  await pool.end();
});

describe("Microsoft Clarity connector", () => {
  it("whatever window is asked, a load is exactly yesterday; loading twice replaces, never duplicates", async () => {
    const deps = await workerDeps({ syncOverrides: { connectorOverride: () => new ClarityConnector({ fetch: fake as never }) } });
    await setGa4Groups(pool, deps.getWarehouse, U.id, conn, ["device"]);
    for (let i = 0; i < 2; i++) {
      await pool.query(
        `insert into public.sync_runs (workspace_id, company_id, connection_id, provider_id, trigger, idempotency_key, window_start, window_end)
         values ($1, $2, $3, 'microsoft_clarity', 'manual', gen_random_uuid()::text, '2026-10-01', '2026-10-30')`,
        [U.workspaceId, company, conn],
      );
      expect(await runSyncOnce(deps)).toBe("succeeded");
    }
    const runs = (await pool.query(`select window_start::text, window_end::text from public.sync_runs where connection_id = $1`, [conn])).rows;
    const tz = (await pool.query(`select timezone from public.companies where id = $1`, [company])).rows[0].timezone;
    const y = (await pool.query(`select ((now() at time zone $1)::date - 1)::text as d`, [tz])).rows[0].d;
    expect(runs.every((r) => r.window_start === y && r.window_end === y)).toBe(true);
    const page = await loadRawPage(pool, deps.getWarehouse, U.id, conn, parseRawTableParams({ period: "all" }, y), { limit: 50, offset: 0 });
    expect(page.total).toBe(2);
    expect(page.columns.map((c) => c.label)).toEqual(["device", "Traffic.totalSessionCount"]);
    await expect(setGa4Groups(pool, deps.getWarehouse, U.id, conn, ["source", "medium", "device", "url"])).rejects.toThrow(/at most 3 breakdowns/);
  });
});
