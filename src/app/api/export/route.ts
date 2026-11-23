import { type NextRequest, NextResponse } from "next/server";
import { getUser } from "@/server/supabase/server";
import { getPool } from "@/server/db";
import { loadConfig } from "@/server/config";
import { AccessDeniedError } from "@/server/auth/authz";
import { getDashboardData, resolveRange } from "@/server/metrics/dashboard";
import { getWarehouse } from "@/server/warehouse";
import { buildReportCsv } from "@/server/reporting/csvExport";

export async function GET(request: NextRequest) {
  const { supabase, user } = await getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const url = new URL(request.url);
  const companyId = url.searchParams.get("company") ?? "";
  const { data: company } = await supabase.from("companies").select("id,name,timezone").eq("id", companyId).maybeSingle();
  if (!company) return NextResponse.json({ error: "not found" }, { status: 404 });
  const range = resolveRange({ from: url.searchParams.get("from"), to: url.searchParams.get("to") }, company.timezone);
  try {
    const cfg = loadConfig();
    const data = await getDashboardData(getPool(), (p) => getWarehouse(p, cfg), user.id, company.id, range);
    if (data.status !== "ready") return NextResponse.json({ error: "data space not ready" }, { status: 409 });
    const csv = buildReportCsv({ companyName: company.name, range, daily: data.dailyRows, campaigns: data.campaigns, generatedAt: new Date(), simulatedWarehouse: data.isSimulatedWarehouse });
    const safeName = company.name.replace(/[^\w-]+/g, "_").slice(0, 40) || "company";
    return new NextResponse(csv, {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="${safeName}_${range.from}_${range.to}.csv"`,
        "cache-control": "no-store",
      },
    });
  } catch (err) {
    if (err instanceof AccessDeniedError) return NextResponse.json({ error: "not found" }, { status: 404 });
    throw err;
  }
}
