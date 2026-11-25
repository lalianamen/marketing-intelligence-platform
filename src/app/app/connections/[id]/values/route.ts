import { type NextRequest, NextResponse } from "next/server";
import { getUser } from "@/server/supabase/server";
import { getPool } from "@/server/db";
import { loadConfig } from "@/server/config";
import { getWarehouse } from "@/server/warehouse";
import { loadConnection, loadRawPage } from "@/server/connections/manage";
import { sanitizeGa4Reports } from "@/lib/ga4Catalog";
import { parseRawTableParams } from "@/lib/rawTable";

// Values that exist in one raw column (most frequent first), for the filter dropdown.
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user } = await getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const db = getPool();
  const conn = await loadConnection(db, user.id, id);
  if (!conn) return NextResponse.json({ error: "not found" }, { status: 404 });
  const url = new URL(req.url);
  const col = (url.searchParams.get("col") ?? "").slice(0, 80);
  const report = url.searchParams.get("report") ?? "core";
  const isGa4Live = conn.provider_id === "ga4" && conn.mode === "live";
  const source = isGa4Live ? (report !== "core" && sanitizeGa4Reports(conn.settings?.ga4_reports).includes(report) ? `ga4:${report}` : "ga4") : undefined;
  const cfg = loadConfig();
  const p = { ...parseRawTableParams({ period: "all" }, "2000-01-01"), suggestFor: [col] };
  const page = await loadRawPage(db, (prov) => getWarehouse(prov, cfg), user.id, id, p, { source, limit: 1, offset: 0 });
  return NextResponse.json({ values: page.suggestions[col] ?? [] }, { headers: { "cache-control": "private, max-age=60" } });
}
