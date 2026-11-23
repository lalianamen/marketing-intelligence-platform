import { timingSafeEqual } from "node:crypto";
import { type NextRequest, NextResponse } from "next/server";
import { runPendingWork } from "@/server/jobs/runner";

// Called by Vercel Cron (Authorization: Bearer $CRON_SECRET) or any scheduler.
// Runs maintenance (lease recovery, reconciliation, due schedules) and drains jobs.
export const maxDuration = 60;
export const dynamic = "force-dynamic";

function authorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret || secret.length < 16) return false;
  const got = Buffer.from(req.headers.get("authorization") ?? "");
  const want = Buffer.from(`Bearer ${secret}`);
  return got.length === want.length && timingSafeEqual(got, want);
}

export async function GET(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const summary = await runPendingWork({ budgetMs: 50_000, maintenance: true });
  return NextResponse.json({ ok: true, ...summary });
}
