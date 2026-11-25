import { addDays } from "../../lib/dates";
import type { DataStatus, NormalizedRow, Origin, RawRecord } from "../../lib/model";
import type { ProviderDailyRecord } from "../connectors/types";
import { sha256Hex } from "../crypto";
import type { CsvRow } from "./csv";

// NORMALIZATION v1 (declarative mapping from source shape → canonical row).
// Bump NORMALIZATION_VERSION when mappings change; RAW is kept so history can be
// re-normalized.
export const NORMALIZATION_VERSION = 1;

export function rowKey(r: Pick<NormalizedRow, "metric_date" | "origin" | "source" | "account_id" | "campaign_id">): string {
  return sha256Hex([r.metric_date, r.origin, r.source, r.account_id, r.campaign_id].join("\u001f"));
}

/** A date is preliminary while it is inside the provider's finalization window. */
export function dataStatusFor(date: string, today: string, finalizationDays: number): DataStatus {
  if (finalizationDays <= 0) return "final";
  return date > addDays(today, -finalizationDays - 1) ? "preliminary" : "final";
}

/** Raw row id = the row's grain (date, origin, source, account, campaign), the sample flag and a duplicate counter. */
export function rawRecordId(grainKey: string, isSimulated: boolean, occurrence: number): string {
  return sha256Hex(`raw|${grainKey}|${isSimulated ? "sim" : "real"}|${occurrence}`);
}

export function normalizeCsvRows(
  rows: CsvRow[],
  ctx: { syncRunId: string; companyTimezone: string; now: Date },
): { normalized: NormalizedRow[]; raw: RawRecord[] } {
  const updatedAt = ctx.now.toISOString();
  const normalized: NormalizedRow[] = [];
  const raw: RawRecord[] = [];
  for (const r of rows) {
    const base = {
      metric_date: r.date,
      origin: "csv" as Origin,
      source: r.source,
      account_id: r.account_id,
      campaign_id: r.campaign_id,
    };
    normalized.push({
      ...base,
      row_key: rowKey(base),
      account_name: r.account_name,
      campaign_name: r.campaign_name,
      currency: r.currency,
      source_timezone: ctx.companyTimezone,
      impressions: r.impressions,
      clicks: r.clicks,
      spend: r.spend,
      sessions: r.sessions,
      conversions: r.conversions,
      conversion_type: r.conversions === null ? null : "csv_conversion",
      leads: r.leads,
      attributed_revenue: r.revenue_type === "attributed" ? r.revenue : null,
      billed_revenue: r.revenue_type === "billed" ? r.revenue : null,
      data_status: "final",
      is_simulated: false,
      sync_run_id: ctx.syncRunId,
      updated_at: updatedAt,
    });
    raw.push({
      // Stable natural key (not per run): re-importing the same grain replaces the raw row.
      record_id: rawRecordId(rowKey(base), false, 0),
      sync_run_id: ctx.syncRunId,
      origin: "csv",
      source: r.source,
      record_date: r.date,
      ingested_at: updatedAt,
      payload_json: JSON.stringify(r),
      is_simulated: false,
      schema_version: NORMALIZATION_VERSION,
    });
  }
  return { normalized, raw };
}

export function normalizeProviderRecords(
  records: ProviderDailyRecord[],
  ctx: { syncRunId: string; origin: Origin; isSimulated: boolean; today: string; finalizationDays: number; now: Date },
): { normalized: NormalizedRow[]; raw: RawRecord[] } {
  const updatedAt = ctx.now.toISOString();
  // Aggregate duplicates of the same grain (e.g. GA4 rows that share an ID).
  const byKey = new Map<string, NormalizedRow>();
  const seen = new Map<string, number>();
  const raw: RawRecord[] = [];
  for (const rec of records) {
    const base = {
      metric_date: rec.date,
      origin: ctx.origin,
      source: ctx.origin,
      account_id: rec.account_id,
      campaign_id: rec.campaign_id,
    };
    const key = rowKey(base);
    const existing = byKey.get(key);
    if (rec.role === "table") {
      // Table-only row: the dashboard uses the day's total record instead.
    } else if (existing) {
      for (const f of ["impressions", "clicks", "spend", "sessions", "conversions", "leads", "attributed_revenue", "billed_revenue"] as const) {
        const a = existing[f];
        const b = rec.metrics[f];
        existing[f] = a === null && b === null ? null : (a ?? 0) + (b ?? 0);
      }
    } else {
      byKey.set(key, {
        ...base,
        row_key: key,
        account_name: rec.account_name,
        campaign_name: rec.campaign_name,
        currency: rec.currency,
        source_timezone: rec.timezone,
        ...rec.metrics,
        data_status: dataStatusFor(rec.date, ctx.today, ctx.finalizationDays),
        is_simulated: ctx.isSimulated,
        sync_run_id: ctx.syncRunId,
        updated_at: updatedAt,
      });
    }
    if (rec.role === "dashboard") continue;
    const rawGrain = rec.rawKey === undefined ? key : `${key}\u001f${rec.rawKey}`;
    const occurrence = seen.get(rawGrain) ?? 0;
    seen.set(rawGrain, occurrence + 1);
    raw.push({
      // Stable natural key (not per run), so a re-sync replaces instead of adding a second copy.
      record_id: rawRecordId(rawGrain, ctx.isSimulated, occurrence),
      sync_run_id: ctx.syncRunId,
      origin: ctx.origin,
      source: ctx.origin,
      record_date: rec.date,
      ingested_at: updatedAt,
      payload_json: JSON.stringify(rec.raw),
      is_simulated: ctx.isSimulated,
      schema_version: NORMALIZATION_VERSION,
    });
  }
  return { normalized: [...byKey.values()], raw };
}
