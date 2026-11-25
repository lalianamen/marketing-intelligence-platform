import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { claimJob, queuePositions } from "@/server/jobs/queue";
import { drain } from "@/worker/worker";
import { createCompany, createVerifiedUser, onlyCompanies, pool, type TestUser, workerDeps } from "./helpers";

let A: TestUser;
let B: TestUser;
let ca: string;
let cb: string;
const conns: Record<string, string[]> = {};

async function addConn(u: TestUser, company: string, n: number) {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    ids.push((await pool.query(
      `insert into public.company_connections (workspace_id, company_id, provider_id, mode, status, external_account_id) values ($1, $2, 'ga4', 'simulated', 'connected', $3) returning id`,
      [u.workspaceId, company, `sim-${i}`],
    )).rows[0].id);
  }
  return ids;
}
async function queue(u: TestUser, company: string, conn: string, trigger: string, key: string) {
  return (await pool.query(
    `insert into public.sync_runs (workspace_id, company_id, connection_id, provider_id, trigger, idempotency_key, is_simulated) values ($1, $2, $3, 'ga4', $4, $5, true) returning id, priority`,
    [u.workspaceId, company, conn, trigger, key],
  )).rows[0] as { id: string; priority: number };
}

beforeAll(async () => {
  A = await createVerifiedUser("routerA");
  B = await createVerifiedUser("routerB");
  ca = await createCompany(A, "Router A");
  cb = await createCompany(B, "Router B");
  await onlyCompanies([ca, cb]);
  await drain(await workerDeps());
  conns.a = await addConn(A, ca, 4);
  conns.b = await addConn(B, cb, 1);
  await pool.query(`update public.sync_runs set status = 'cancelled' where status = 'queued'`);
});
afterAll(async () => {
  await pool.query(`update public.sync_runs set status = 'cancelled' where status in ('queued', 'running') and company_id = any($1::uuid[])`, [[ca, cb]]);
  await pool.end();
});

describe("job router", () => {
  it("what a person waits for goes first; history last; one company cannot take every worker", async () => {
    const hist = [];
    for (let i = 0; i < 4; i++) hist.push(await queue(A, ca, conns.a![i]!, "backfill", `history:${conns.a![i]}:${i}`));
    const sched = await queue(B, cb, conns.b![0]!, "scheduled", `sched-${cb}`);
    expect(hist.every((h) => h.priority === 90)).toBe(true);
    expect(sched.priority).toBe(50);

    const pos = await queuePositions(pool, [sched.id, hist[0]!.id]);
    expect(pos.get(sched.id)).toBe(1);

    const first = await claimJob(pool, "sync_runs", "w1", 300, { maxRunningPerProvider: 8 });
    expect(first!.id).toBe(sched.id); // scheduled beats history
    const second = await claimJob(pool, "sync_runs", "w2", 300, { maxRunningPerProvider: 8 });
    const third = await claimJob(pool, "sync_runs", "w3", 300, { maxRunningPerProvider: 8 });
    const fourth = await claimJob(pool, "sync_runs", "w4", 300, { maxRunningPerProvider: 8 });
    expect([second?.company_id, third?.company_id]).toEqual([ca, ca]);
    expect(fourth).toBeNull(); // company A already has 2 running

    const manual = await queue(B, cb, conns.b![0]!, "manual", `manual-${cb}`);
    expect(manual.priority).toBe(10);
    expect((await queuePositions(pool, [manual.id])).get(manual.id)).toBe(1);
  });
});
