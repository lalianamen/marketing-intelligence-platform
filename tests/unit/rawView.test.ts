import { describe, expect, it } from "vitest";
import { flattenRawPayload, rawColumns } from "@/lib/rawView";

describe("raw data view", () => {
  it("labels GA4 report values with the requested dimension and metric names", () => {
    const p = JSON.stringify({ dimensions: [{ value: "20261120" }, { value: "(not set)" }, { value: "(not set)" }], metrics: [{ value: "42" }, { value: "3" }, { value: "0" }] });
    expect(flattenRawPayload("ga4", p)).toEqual({ date: "20261120", sessionCampaignId: "(not set)", sessionCampaignName: "(not set)", sessions: "42", keyEvents: "3", totalRevenue: "0" });
  });
  it("flattens nested objects with dotted keys and keeps unparseable text", () => {
    expect(flattenRawPayload("google_ads", JSON.stringify({ campaign: { id: "1", name: "Brand" }, metrics: { clicks: "5" } }))).toEqual({ "campaign.id": "1", "campaign.name": "Brand", "metrics.clicks": "5" });
    expect(flattenRawPayload("csv", "not json")).toEqual({ raw: "not json" });
  });
  it("builds columns in first-seen order", () => {
    expect(rawColumns([{ a: "1", b: "2" }, { c: "3", a: "4" }])).toEqual(["a", "b", "c"]);
  });
});

describe("GA4 catalog", () => {
  it("core report is what the connector requests; every switchable report fits GA4 limits", async () => {
    const { GA4_REPORTS, GA4_OPTIONAL_REPORTS, sanitizeGa4Reports } = await import("@/lib/ga4Catalog");
    const { GA4_DIMENSIONS, GA4_METRICS } = await import("@/lib/rawView");
    const core = GA4_REPORTS.find((r) => r.core)!;
    expect(core.dimensions.map((d) => d.name)).toEqual([...GA4_DIMENSIONS]);
    expect(core.metrics.map((m) => m.name)).toEqual([...GA4_METRICS]);
    for (const r of GA4_OPTIONAL_REPORTS) {
      expect(r.dimensions[0]!.name).toBe("date");
      expect(r.dimensions.length).toBeLessThanOrEqual(9); // GA4 runReport limit
      expect(r.metrics.length).toBeGreaterThan(0);
      expect(r.metrics.length).toBeLessThanOrEqual(10);
    }
    expect(sanitizeGa4Reports(["geo", "core", "nope", "raw_events", "traffic_sources"])).toEqual(["traffic_sources", "geo"]);
  });
});
