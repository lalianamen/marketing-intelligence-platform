import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { drain } from "@/worker/worker";
import { createCompany, createVerifiedUser, onlyCompanies, pool, type TestUser, workerDeps } from "./helpers";

let U: TestUser;
let company: string;
let conn: string;

beforeAll(async () => {
  U = await createVerifiedUser("hist");
  company = await createCompany(U, "History Co");
  await onlyCompanies([company]);
  await drain(await workerDeps());
  expect((await U.client.rpc("enable_simulated_connection", { p_company_id: company, p_provider_id: "ga4" })).error).toBeNull();
  conn = (await pool.query(`select id from public.company_connections where company_id = $1`, [company])).rows[0].id;
  await pool.query(`update public.sync_runs set status = 'cancelled' where connection_id = $1 and status = 'queued'`, [conn]);
});
afterAll(async () => {
  await pool.end();
});

describe("loads are limited to one month per run", () => {
  it("a manual window longer than 31 days is refused", async () => {
    const r = await U.client.rpc("request_sync", { p_connection_id: conn, p_window_start: "2026-08-01", p_window_end: "2026-09-30" });
    expect(r.error?.message).toMatch(/invalid window/);
  });

  it("history is split into parts of at most 31 days, newest first, covering the whole period once", async () => {
    const r = await U.client.rpc("request_history", { p_connection_id: conn, p_from: "2026-07-01", p_to: "2026-10-31" });
    expect(r.error).toBeNull();
    const parts = (await pool.query(
      `select window_start::text s, window_end::text e, trigger from public.sync_runs where connection_id = $1 and status = 'queued' order by run_after`,
      [conn],
    )).rows;
    expect(r.data).toBe(parts.length);
    expect(parts.every((p) => p.trigger === "backfill")).toBe(true);
    expect(parts[0]!.e).toBe("2026-10-31");
    expect(parts[parts.length - 1]!.s).toBe("2026-07-01");
    for (const p of parts) expect((Date.parse(p.e) - Date.parse(p.s)) / 86400000 + 1).toBeLessThanOrEqual(31);
    const days = parts.reduce((n, p) => n + (Date.parse(p.e) - Date.parse(p.s)) / 86400000 + 1, 0);
    expect(days).toBe(123); // Jul 1 – Oct 31
    // A second request while parts are still queued is refused.
    expect((await U.client.rpc("request_history", { p_connection_id: conn, p_from: "2026-07-01", p_to: "2026-07-31" })).error?.message).toMatch(/already in progress/);
    await drain(await workerDeps({ now: () => new Date("2026-11-23T12:00:00Z") }));
    const done = (await pool.query(`select status from public.sync_runs where connection_id = $1 and trigger = 'backfill'`, [conn])).rows;
    expect(done.every((d) => d.status === "succeeded")).toBe(true);
  });
});
