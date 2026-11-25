import { type NextRequest, NextResponse } from "next/server";
import { getPool } from "@/server/db";
import { runPendingWork } from "@/server/jobs/runner";
import { isSchedulerRequest } from "@/server/jobs/schedulerAuth";

// Called by Vercel Cron (Bearer $CRON_SECRET, daily) and by the database's hourly
// scheduler (pg_cron + pg_net, Bearer token kept in Supabase Vault).
// Runs maintenance (lease recovery, reconciliation, due schedules) and drains jobs.
export const maxDuration = 60;
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  if (!(await isSchedulerRequest(getPool(), req.headers.get("authorization"), process.env.CRON_SECRET))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const summary = await runPendingWork({ budgetMs: 50_000, maintenance: true });
  return NextResponse.json({ ok: true, ...summary });
}
