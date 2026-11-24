import { timingSafeEqual } from "node:crypto";
import { type NextRequest, NextResponse } from "next/server";
import { loadConfig } from "@/server/config";
import { getPool } from "@/server/db";

// Health check. Public: {status: ok|error} only. With CRON_SECRET: DB detail and
// non-secret configuration flags. Never returns secret values.
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET ?? "";
  const got = Buffer.from(req.headers.get("authorization") ?? "");
  const want = Buffer.from(`Bearer ${secret}`);
  const operator = secret.length >= 16 && got.length === want.length && timingSafeEqual(got, want);
  const cfg = loadConfig();
  let db: string;
  try {
    const r = await getPool().query<{ n: number }>("select count(*)::int as n from public.connector_providers");
    db = `ok (${r.rows[0]?.n} providers)`;
  } catch (err) {
    db = `error: ${(err as { code?: string }).code ?? "unknown"} ${(err as Error).message.slice(0, 120)}`;
  }
  // Public callers only learn whether the service works; details need CRON_SECRET.
  if (!operator) return NextResponse.json({ status: db.startsWith("ok") ? "ok" : "error" }, { status: db.startsWith("ok") ? 200 : 503 });
  return NextResponse.json({
    db,
    warehouseMode: cfg.warehouseMode,
    bigqueryProject: cfg.bigquery.projectId ?? null,
    billingApproved: cfg.bigquery.billingApproved,
    workloadIdentity: Boolean(process.env.GCP_WORKLOAD_IDENTITY_PROVIDER && process.env.GCP_SERVICE_ACCOUNT_EMAIL),
    googleOAuth: Boolean(cfg.google.clientId),
  });
}
