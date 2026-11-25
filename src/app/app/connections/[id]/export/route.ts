import { type NextRequest, NextResponse } from "next/server";
import { getUser } from "@/server/supabase/server";
import { getPool } from "@/server/db";
import { loadConfig } from "@/server/config";
import { getWarehouse } from "@/server/warehouse";
import { loadConnection, loadRawPage } from "@/server/connections/manage";
import { sanitizeGa4Reports } from "@/lib/ga4Catalog";
import { addDays, localDate } from "@/lib/dates";
import { csvCell, parseRawTableParams, valueAt } from "@/lib/rawTable";

// CSV export of a connector's raw data: the current view (period, filters, sort)
// or, with full=1, the whole stored period without filters. Access is checked
// for the signed-in user; at most EXPORT_LIMIT rows per file.
export const dynamic = "force-dynamic";
export const maxDuration = 60;
const EXPORT_LIMIT = 50_000;

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user } = await getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const db = getPool();
  const conn = await loadConnection(db, user.id, id);
  if (!conn) return NextResponse.json({ error: "not found" }, { status: 404 });
  const tz = (await db.query<{ timezone: string }>(`select timezone from public.companies where id = $1`, [conn.company_id])).rows[0]?.timezone ?? "UTC";
  const sp = Object.fromEntries(new URL(req.url).searchParams.entries());
  const yesterday = addDays(localDate(new Date(), tz), -1);
  const p = parseRawTableParams(sp, yesterday);
  const full = sp.full === "1";
  const report = conn.provider_id === "ga4" && conn.mode === "live" && sp.report && sanitizeGa4Reports(conn.settings?.ga4_reports).includes(sp.report) ? sp.report : "core";
  const source = conn.provider_id === "ga4" && conn.mode === "live" ? (report === "core" ? "ga4" : `ga4:${report}`) : undefined;
  const cfg = loadConfig();
  const page = await loadRawPage(db, (prov) => getWarehouse(prov, cfg), user.id, id, p, { source, limit: EXPORT_LIMIT, offset: 0, ignoreFilters: full });
  const header = ["day", ...page.columns.map((c) => c.label), "imported_at_utc"];
  const lines = [header.map(csvCell).join(",")];
  for (const r of page.rows) {
    let payload: unknown;
    try {
      payload = JSON.parse(r.payload_json);
    } catch {
      payload = {};
    }
    const cells = page.columns.map((c) => valueAt(payload, c.path));
    lines.push([r.record_date, ...cells, r.ingested_at].map((x) => csvCell(String(x))).join(","));
  }
  const period = full ? "all" : `${p.from ?? "start"}_${p.to ?? "end"}`;
  const name = `${conn.provider_id}-${report}-${period}.csv`.replace(/[^\w.-]/g, "_");
  const body = "﻿" + lines.join("\r\n") + "\r\n";
  return new NextResponse(body, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${name}"`,
      "cache-control": "no-store",
      ...(page.total > EXPORT_LIMIT ? { "x-rows-truncated": `${EXPORT_LIMIT} of ${page.total}` } : {}),
    },
  });
}
