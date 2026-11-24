import { timingSafeEqual } from "node:crypto";
import { type NextRequest, NextResponse } from "next/server";
import { loadConfig } from "@/server/config";
import { getPool } from "@/server/db";

// Operator health check (CRON_SECRET-protected): verifies DB connectivity and
// reports non-secret configuration flags. Never returns secret values.
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET ?? "";
  const got = Buffer.from(req.headers.get("authorization") ?? "");
  const want = Buffer.from(`Bearer ${secret}`);
  if (secret.length < 16 || got.length !== want.length || !timingSafeEqual(got, want)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const cfg = loadConfig();
  let db: string;
  try {
    const r = await getPool().query<{ n: number }>("select count(*)::int as n from public.connector_providers");
    db = `ok (${r.rows[0]?.n} providers)`;
  } catch (err) {
    db = `error: ${(err as { code?: string }).code ?? "unknown"} ${(err as Error).message.slice(0, 120)}`;
  }
  return NextResponse.json({
    db,
    warehouseMode: cfg.warehouseMode,
    bigqueryProject: cfg.bigquery.projectId ?? null,
    billingApproved: cfg.bigquery.billingApproved,
    workloadIdentity: Boolean(process.env.GCP_WORKLOAD_IDENTITY_PROVIDER && process.env.GCP_SERVICE_ACCOUNT_EMAIL),
    googleOAuth: Boolean(cfg.google.clientId),
  });
}
