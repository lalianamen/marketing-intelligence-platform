import type { CampaignRow, MartRow } from "../../lib/model";

// Excel-compatible CSV export (UTF-8 with BOM, CRLF line endings).
// Spreadsheet formula injection: text cells beginning with = + - @ TAB or CR
// are prefixed with a single quote so spreadsheet apps treat them as text.
// Numbers are written as plain numbers.

export function escapeCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "";
  if (typeof v === "boolean") return v ? "true" : "false";
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  if (/[",\r\n]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function toCsv(header: string[], rows: unknown[][]): string {
  return "﻿" + [header, ...rows].map((r) => r.map(escapeCell).join(",")).join("\r\n") + "\r\n";
}

export function buildReportCsv(opts: {
  companyName: string;
  range: { from: string; to: string };
  daily: MartRow[];
  campaigns: CampaignRow[];
  generatedAt: Date;
  simulatedWarehouse: boolean;
}): string {
  const meta: unknown[][] = [
    ["report", "Marketing Intelligence — daily metrics by source"],
    ["company", opts.companyName],
    ["period", `${opts.range.from} to ${opts.range.to}`],
    ["generated_at", opts.generatedAt.toISOString()],
    ["warehouse", opts.simulatedWarehouse ? "LOCAL SIMULATED WAREHOUSE (not BigQuery)" : "BigQuery"],
    ["note", "Empty cell = not available from this source (not zero). Money is not converted between currencies. Conversions of different sources have different definitions and must not be added together."],
    [],
  ];
  const dailyHeader = [
    "section", "date", "origin", "source", "currency", "is_simulated", "data_status",
    "impressions", "clicks", "spend", "sessions", "conversions", "conversion_type", "leads",
    "attributed_revenue", "billed_revenue", "campaign_count",
  ];
  const dailyRows = opts.daily.map((r) => [
    "daily", r.metric_date, r.origin, r.source, r.currency, r.is_simulated, r.has_preliminary ? "preliminary" : "final",
    r.impressions, r.clicks, r.spend, r.sessions, r.conversions, r.conversion_type, r.leads,
    r.attributed_revenue, r.billed_revenue, r.campaign_count,
  ]);
  const campHeader = [
    "section", "origin", "source", "account_id", "account_name", "campaign_id", "campaign_name", "currency", "is_simulated",
    "first_date", "last_date", "impressions", "clicks", "spend", "sessions", "conversions", "conversion_type", "leads", "attributed_revenue",
  ];
  const campRows = opts.campaigns.map((c) => [
    "campaign", c.origin, c.source, c.account_id, c.account_name, c.campaign_id, c.campaign_name, c.currency, c.is_simulated,
    c.first_date, c.last_date, c.impressions, c.clicks, c.spend, c.sessions, c.conversions, c.conversion_type, c.leads, c.attributed_revenue,
  ]);
  const lines = [
    ...meta.map((r) => r.map(escapeCell).join(",")),
    dailyHeader.join(","),
    ...dailyRows.map((r) => r.map(escapeCell).join(",")),
    "",
    campHeader.join(","),
    ...campRows.map((r) => r.map(escapeCell).join(",")),
  ];
  return "﻿" + lines.join("\r\n") + "\r\n";
}
