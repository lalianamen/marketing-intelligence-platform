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
