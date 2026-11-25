import "server-only";
import { createHash, timingSafeEqual } from "node:crypto";
import type { Queryable } from "../db";

/**
 * Who may trigger /api/jobs/run: Vercel Cron (Bearer CRON_SECRET) or the
 * database's hourly scheduler (Bearer token whose SHA-256 is stored in
 * private.scheduler_tokens; the token itself lives only in Supabase Vault).
 */
export async function isSchedulerRequest(db: Queryable, authorization: string | null, cronSecret: string | undefined): Promise<boolean> {
  const header = authorization ?? "";
  if (!header.startsWith("Bearer ")) return false;
  const token = header.slice(7);
  if (cronSecret && cronSecret.length >= 16) {
    const got = Buffer.from(header);
    const want = Buffer.from(`Bearer ${cronSecret}`);
    if (got.length === want.length && timingSafeEqual(got, want)) return true;
  }
  if (!/^[0-9a-f]{64}$/.test(token)) return false;
  const hash = createHash("sha256").update(token).digest("hex");
  try {
    const r = await db.query(`select 1 from private.scheduler_tokens where token_sha256 = $1`, [hash]);
    return (r.rowCount ?? 0) > 0;
  } catch {
    return false;
  }
}
