import { createHash } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { isSchedulerRequest } from "@/server/jobs/schedulerAuth";
import { pool } from "./helpers";

afterAll(async () => {
  await pool.end();
});

describe("who may trigger background jobs", () => {
  it("accepts the database scheduler's token (stored only as a hash) and the Vercel cron secret, nothing else", async () => {
    const token = "a".repeat(64);
    await pool.query(
      `insert into private.scheduler_tokens (id, token_sha256) values (1, $1) on conflict (id) do update set token_sha256 = excluded.token_sha256`,
      [createHash("sha256").update(token).digest("hex")],
    );
    const cron = "cron-secret-of-sufficient-length";
    expect(await isSchedulerRequest(pool, `Bearer ${token}`, cron)).toBe(true);
    expect(await isSchedulerRequest(pool, `Bearer ${cron}`, cron)).toBe(true);
    expect(await isSchedulerRequest(pool, `Bearer ${"b".repeat(64)}`, cron)).toBe(false);
    expect(await isSchedulerRequest(pool, "Bearer short", "short")).toBe(false);
    expect(await isSchedulerRequest(pool, null, cron)).toBe(false);
    expect(await isSchedulerRequest(pool, token, cron)).toBe(false);
  });
});
