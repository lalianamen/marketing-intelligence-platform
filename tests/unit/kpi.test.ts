import { describe, expect, it } from "vitest";
import { computeKpis, percentChange, safeRatio, summarizePeriod, totals } from "@/lib/kpi";
import type { MartRow } from "@/lib/model";

function row(p: Partial<MartRow>): MartRow {
  return {
    metric_date: "2026-11-01",
    origin: "csv",
    source: "meta_ads",
    currency: "USD",
    is_simulated: false,
    impressions: null,
    clicks: null,
    spend: null,
    sessions: null,
    conversions: null,
    conversion_type: null,
    leads: null,
    attributed_revenue: null,
    billed_revenue: null,
    campaign_count: 1,
    has_preliminary: false,
    ...p,
  };
}

describe("KPI formulas", () => {
  it("computes CPC, CTR, CPM, CPL, conversion rate and ROAS", () => {
    const k = computeKpis([
      row({ impressions: 10_000, clicks: 200, spend: 300, conversions: 10, leads: 5, attributed_revenue: 900, conversion_type: "csv_conversion" }),
    ]);
    expect(k.cpc).toEqual({ value: 1.5, status: "ok" });
    expect(k.ctr.value).toBeCloseTo(2);
    expect(k.cpm.value).toBeCloseTo(30);
    expect(k.cpl.value).toBeCloseTo(60);
    expect(k.conversion_rate.value).toBeCloseTo(5);
    expect(k.roas.value).toBeCloseTo(3);
  });

  it("returns zero_denominator instead of Infinity/NaN", () => {
    const k = computeKpis([row({ impressions: 0, clicks: 0, spend: 10 })]);
    expect(k.ctr.status).toBe("zero_denominator");
    expect(k.cpc.status).toBe("zero_denominator");
    expect(k.cpm.status).toBe("zero_denominator");
    expect(k.ctr.value).toBeNull();
  });

  it("returns not_available when inputs are missing (no lead or revenue data)", () => {
    const k = computeKpis([row({ impressions: 100, clicks: 5, spend: 10 })]);
    expect(k.cpl.status).toBe("not_available");
    expect(k.roas.status).toBe("not_available");
    expect(k.conversion_rate.status).toBe("not_available");
  });

  it("uses paired sums: never divides one source's clicks by another source's impressions", () => {
    const k = computeKpis([
      row({ source: "a", impressions: 1000, clicks: null }),
      row({ source: "b", impressions: null, clicks: 50 }),
    ]);
    expect(k.ctr.status).toBe("not_available");
  });

  it("refuses money ratios across currencies", () => {
    const k = computeKpis([row({ currency: "USD", spend: 10, clicks: 10 }), row({ currency: "EUR", spend: 10, clicks: 10 })]);
    expect(k.cpc.status).toBe("mixed_currency");
    const t = totals([row({ currency: "USD", spend: 10 }), row({ currency: "EUR", spend: 7 })]);
    expect(t.spendByCurrency).toEqual({ USD: 10, EUR: 7 });
  });

  it("keeps null (not available) distinct from zero in totals", () => {
    expect(totals([row({ leads: null })]).leads).toBeNull();
    expect(totals([row({ leads: 0 })]).leads).toBe(0);
  });

  it("safeRatio handles nulls and zero", () => {
    expect(safeRatio(null, 1).status).toBe("not_available");
    expect(safeRatio(1, 0).status).toBe("zero_denominator");
    expect(safeRatio(1, 4, 100).value).toBe(25);
  });

  it("percentChange is null when previous is zero or missing", () => {
    expect(percentChange(10, 0)).toBeNull();
    expect(percentChange(null, 5)).toBeNull();
    expect(percentChange(15, 10)).toBe(50);
  });
});

describe("summarizePeriod", () => {
  it("does not blend conversions across sources and groups by source", () => {
    const s = summarizePeriod(
      [
        row({ origin: "ga4", source: "ga4", conversions: 30, conversion_type: "ga4_key_event", sessions: 900 }),
        row({ origin: "google_ads", source: "google_ads", conversions: 12, conversion_type: "ad_platform_conversion", clicks: 100, impressions: 1000, spend: 50 }),
      ],
      { from: "2026-11-01", to: "2026-11-01" },
    );
    expect(s.bySource).toHaveLength(2);
    expect("conversions" in s.blended.totals).toBe(false);
    expect(s.bySource.find((x) => x.origin === "ga4")!.conversionType).toBe("ga4_key_event");
    expect(s.blended.kpis.ctr.value).toBeCloseTo(10);
    expect(s.daily[0]!.spend).toBe(50);
  });

  it("flags simulated and preliminary data", () => {
    const s = summarizePeriod([row({ is_simulated: true, has_preliminary: true, clicks: 1 })], { from: "2026-11-01", to: "2026-11-01" });
    expect(s.hasSimulated).toBe(true);
    expect(s.hasPreliminary).toBe(true);
  });

  it("never blends simulated rows into totals when real data exists", () => {
    const s = summarizePeriod(
      [row({ source: "meta_ads", clicks: 10, impressions: 100, spend: 5 }), row({ origin: "google_ads", source: "google_ads", is_simulated: true, clicks: 1000, impressions: 5000, spend: 900 })],
      { from: "2026-11-01", to: "2026-11-01" },
    );
    expect(s.blendedScope).toBe("real");
    expect(s.blended.totals.clicks).toBe(10);
    expect(s.blended.totals.spendByCurrency).toEqual({ USD: 5 });
    expect(s.bySource).toHaveLength(2); // still visible per source, labelled
    const onlySample = summarizePeriod([row({ is_simulated: true, clicks: 3 })], { from: "2026-11-01", to: "2026-11-01" });
    expect(onlySample.blendedScope).toBe("simulated");
    expect(onlySample.blended.totals.clicks).toBe(3);
  });

  it("daily spend is null when several currencies exist", () => {
    const s = summarizePeriod([row({ currency: "USD", spend: 1 }), row({ currency: "EUR", spend: 1 })], { from: "2026-11-01", to: "2026-11-01" });
    expect(s.daily[0]!.spend).toBeNull();
    expect(s.blended.kpis.cpc.status).not.toBe("ok");
  });
});
