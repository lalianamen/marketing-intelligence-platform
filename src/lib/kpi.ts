import type { ConversionType, MartRow, Origin } from "./model";

// KPI engine. Formulas (docs/DATA_MODEL.md#metrics):
//   CPC  = spend / clicks
//   CTR  = clicks / impressions × 100
//   CPM  = spend / impressions × 1000
//   CPL  = spend / leads                (only rows that supply leads)
//   CVR  = conversions / clicks × 100   (same-source conversions; denominator = clicks)
//   ROAS = attributed_revenue / spend   (platform-reported, same source)
// Ratios are computed from PAIRED sums: only rows where both numerator and
// denominator are present contribute, so one source's clicks are never divided
// by another source's impressions. Missing inputs → "not_available", never 0.
// Money ratios require a single currency (no FX conversion in Phase 1).

export type KpiStatus = "ok" | "not_available" | "zero_denominator" | "mixed_currency";
export interface KpiValue {
  value: number | null;
  status: KpiStatus;
  note?: string;
}
export type KpiKey = "ctr" | "cpc" | "cpm" | "cpl" | "conversion_rate" | "roas";

export function safeRatio(n: number | null, d: number | null, scale = 1): KpiValue {
  if (n === null || d === null) return { value: null, status: "not_available" };
  if (d === 0) return { value: null, status: "zero_denominator", note: "denominator is zero" };
  return { value: (n / d) * scale, status: "ok" };
}

type Row = Pick<
  MartRow,
  "currency" | "impressions" | "clicks" | "spend" | "sessions" | "conversions" | "leads" | "attributed_revenue" | "billed_revenue"
>;

function pairSum(rows: Row[], nf: keyof Row, df: keyof Row): { n: number | null; d: number | null; currencies: Set<string> } {
  let n = 0;
  let d = 0;
  let any = false;
  const currencies = new Set<string>();
  for (const r of rows) {
    const a = r[nf] as number | null;
    const b = r[df] as number | null;
    if (a === null || b === null || a === undefined || b === undefined) continue;
    any = true;
    n += a;
    d += b;
    currencies.add(r.currency ?? "?");
  }
  return any ? { n, d, currencies } : { n: null, d: null, currencies };
}

function moneyRatio(rows: Row[], nf: keyof Row, df: keyof Row, scale = 1): KpiValue {
  const p = pairSum(rows, nf, df);
  if (p.currencies.size > 1) return { value: null, status: "mixed_currency", note: `several currencies: ${[...p.currencies].join(", ")}` };
  return safeRatio(p.n, p.d, scale);
}

export function computeKpis(rows: Row[]): Record<KpiKey, KpiValue> {
  const ctr = pairSum(rows, "clicks", "impressions");
  const cvr = pairSum(rows, "conversions", "clicks");
  return {
    ctr: safeRatio(ctr.n, ctr.d, 100),
    cpc: moneyRatio(rows, "spend", "clicks"),
    cpm: moneyRatio(rows, "spend", "impressions", 1000),
    cpl: moneyRatio(rows, "spend", "leads"),
    conversion_rate: safeRatio(cvr.n, cvr.d, 100),
    roas: moneyRatio(rows, "attributed_revenue", "spend"),
  };
}

/** Sum that preserves "not available": null when no row has a value. */
export function sumOrNull<T>(rows: T[], f: (r: T) => number | null | undefined): number | null {
  let s = 0;
  let any = false;
  for (const r of rows) {
    const v = f(r);
    if (v === null || v === undefined) continue;
    s += v;
    any = true;
  }
  return any ? s : null;
}

export interface Totals {
  impressions: number | null;
  clicks: number | null;
  sessions: number | null;
  conversions: number | null;
  leads: number | null;
  /** Money totals are always split by currency. */
  spendByCurrency: Record<string, number>;
  attributedRevenueByCurrency: Record<string, number>;
  billedRevenueByCurrency: Record<string, number>;
}

function byCurrency(rows: Row[], f: "spend" | "attributed_revenue" | "billed_revenue"): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows) {
    const v = r[f];
    if (v === null || v === undefined) continue;
    const c = r.currency ?? "UNKNOWN";
    out[c] = (out[c] ?? 0) + v;
  }
  return out;
}

export function totals(rows: Row[]): Totals {
  return {
    impressions: sumOrNull(rows, (r) => r.impressions),
    clicks: sumOrNull(rows, (r) => r.clicks),
    sessions: sumOrNull(rows, (r) => r.sessions),
    conversions: sumOrNull(rows, (r) => r.conversions),
    leads: sumOrNull(rows, (r) => r.leads),
    spendByCurrency: byCurrency(rows, "spend"),
    attributedRevenueByCurrency: byCurrency(rows, "attributed_revenue"),
    billedRevenueByCurrency: byCurrency(rows, "billed_revenue"),
  };
}

export interface SourceSummary {
  key: string;
  origin: Origin;
  source: string;
  isSimulated: boolean;
  conversionType: ConversionType | null | "mixed";
  hasPreliminary: boolean;
  totals: Totals;
  kpis: Record<KpiKey, KpiValue>;
}

export interface DailyPoint {
  date: string;
  clicks: number | null;
  impressions: number | null;
  sessions: number | null;
  spend: number | null; // only when a single currency exists in the period
}

export interface PeriodSummary {
  from: string;
  to: string;
  /** Blended across sources: only additive, same-unit metrics. Conversions are NOT blended. */
  blended: { totals: Omit<Totals, "conversions" | "leads">; kpis: Pick<Record<KpiKey, KpiValue>, "ctr" | "cpc" | "cpm"> };
  bySource: SourceSummary[];
  daily: DailyPoint[];
  currencies: string[];
  hasSimulated: boolean;
  hasPreliminary: boolean;
  rowCount: number;
  /**
   * Which rows the blended cards/daily series use. Simulated (sample) rows are
   * never mixed into totals together with real data: when real rows exist, the
   * blend uses real rows only; otherwise it uses the sample rows (and the UI
   * labels the whole view as SIMULATED).
   */
  blendedScope: "real" | "simulated" | "empty";
}

export function summarizePeriod(rows: MartRow[], range: { from: string; to: string }): PeriodSummary {
  const groups = new Map<string, MartRow[]>();
  for (const r of rows) {
    const key = `${r.origin}|${r.source}|${r.is_simulated ? "sim" : "real"}`;
    const g = groups.get(key) ?? [];
    g.push(r);
    groups.set(key, g);
  }
  const bySource: SourceSummary[] = [...groups.entries()].map(([key, g]) => {
    const types = new Set(g.map((r) => r.conversion_type).filter((x) => x !== null));
    return {
      key,
      origin: g[0]!.origin,
      source: g[0]!.source,
      isSimulated: g[0]!.is_simulated,
      conversionType: types.size === 0 ? null : types.size === 1 ? ([...types][0] as ConversionType) : "mixed",
      hasPreliminary: g.some((r) => r.has_preliminary),
      totals: totals(g),
      kpis: computeKpis(g),
    };
  });
  bySource.sort((a, b) => a.origin.localeCompare(b.origin) || a.source.localeCompare(b.source));

  const real = rows.filter((r) => !r.is_simulated);
  const blendRows = real.length ? real : rows;
  const t = totals(blendRows);
  const k = computeKpis(blendRows);
  const currencies = Object.keys(t.spendByCurrency).sort();
  const days = new Map<string, MartRow[]>();
  for (const r of blendRows) days.set(r.metric_date, [...(days.get(r.metric_date) ?? []), r]);
  const daily: DailyPoint[] = [...days.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, g]) => ({
      date,
      clicks: sumOrNull(g, (r) => r.clicks),
      impressions: sumOrNull(g, (r) => r.impressions),
      sessions: sumOrNull(g, (r) => r.sessions),
      spend: currencies.length === 1 ? sumOrNull(g, (r) => r.spend) : null,
    }));

  return {
    from: range.from,
    to: range.to,
    blended: {
      totals: {
        impressions: t.impressions,
        clicks: t.clicks,
        sessions: t.sessions,
        spendByCurrency: t.spendByCurrency,
        attributedRevenueByCurrency: t.attributedRevenueByCurrency,
        billedRevenueByCurrency: t.billedRevenueByCurrency,
      },
      kpis: { ctr: k.ctr, cpc: k.cpc, cpm: k.cpm },
    },
    bySource,
    daily,
    currencies,
    hasSimulated: rows.some((r) => r.is_simulated),
    hasPreliminary: rows.some((r) => r.has_preliminary),
    rowCount: rows.length,
    blendedScope: rows.length === 0 ? "empty" : real.length ? "real" : "simulated",
  };
}

/** Relative change; null when not comparable. */
export function percentChange(current: number | null, previous: number | null): number | null {
  if (current === null || previous === null || previous === 0) return null;
  return ((current - previous) / Math.abs(previous)) * 100;
}
