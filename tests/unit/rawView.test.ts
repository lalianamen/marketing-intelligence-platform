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

describe("GA4 one-table catalog", () => {
  it("base fields are what the connector always requests; groups add columns within GA4 limits", async () => {
    const { GA4_CORE, ga4Fields, ga4SelectionProblem, sanitizeGa4Selection } = await import("@/lib/ga4Catalog");
    const { GA4_DIMENSIONS, GA4_METRICS } = await import("@/lib/rawView");
    expect(GA4_CORE.dimensions.map((d) => d.name)).toEqual([...GA4_DIMENSIONS]);
    expect(GA4_CORE.metrics.map((m) => m.name)).toEqual([...GA4_METRICS]);
    expect(ga4Fields([]).dimensions).toEqual(["date", "sessionCampaignId", "sessionCampaignName"]);
    expect(ga4Fields(["devices", "traffic_sources"]).dimensions).toEqual([
      "date", "sessionCampaignId", "sessionCampaignName", "sessionSource", "sessionMedium", "sessionDefaultChannelGroup", "deviceCategory", "operatingSystem", "browser",
    ]);
    expect(ga4SelectionProblem(["traffic_sources", "devices"])).toBeNull(); // 9 breakdowns: the limit
    expect(ga4SelectionProblem(["traffic_sources", "devices", "landing_pages"])).toMatch(/at most 9 breakdowns/);
    expect(ga4SelectionProblem(["engagement", "users", "conversions"])).toBeNull(); // 10 numbers
    expect(sanitizeGa4Selection(["city", "core", "nope", "traffic_sources"])).toEqual(["sessionSource", "sessionMedium", "sessionDefaultChannelGroup", "city"]);
    // single fields: only what was ticked goes into the request
    expect(ga4Fields(["sessionSource", "deviceCategory", "newUsers"])).toEqual({
      dimensions: ["date", "sessionCampaignId", "sessionCampaignName", "sessionSource", "deviceCategory"],
      metrics: ["sessions", "keyEvents", "totalRevenue", "newUsers"],
    });
    expect(ga4SelectionProblem(["traffic_sources", "devices", "city"])).toMatch(/at most 9 breakdowns/);
  });
});
