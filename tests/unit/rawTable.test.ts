import { describe, expect, it, vi } from "vitest";
import { csvCell, parseRawTableParams, rawColumnsFor, rawTableQuery } from "@/lib/rawTable";
import { BigQueryWarehouse } from "@/server/warehouse/bigquery";

describe("raw table parameters", () => {
  it("defaults to the last 30 complete days, newest first", () => {
    const p = parseRawTableParams({}, "2026-11-24");
    expect(p).toMatchObject({ preset: "30", from: "2026-10-26", to: "2026-11-24", sort: "day", dir: "desc", page: 1, filters: [] });
  });
  it("reads presets, custom period, filters and sorting; ignores junk", () => {
    expect(parseRawTableParams({ period: "all" }, "2026-11-24")).toMatchObject({ from: null, to: null });
    const p = parseRawTableParams(
      { period: "custom", from: "2026-11-01", to: "bad", f1c: "sessions", f1o: "gt", f1v: "5", f2c: "x", f2o: "drop", f2v: "1", sort: "sessions", dir: "asc", page: "3" },
      "2026-11-24",
    );
    expect(p).toMatchObject({ preset: "custom", from: "2026-11-01", to: null, sort: "sessions", dir: "asc", page: 3 });
    expect(p.filters).toEqual([{ col: "sessions", op: "gt", value: "5" }]);
    const q = new URLSearchParams(rawTableQuery({ report: "geo" }, p, { page: 1 }));
    expect(Object.fromEntries(q)).toMatchObject({ report: "geo", period: "custom", from: "2026-11-01", f1c: "sessions", f1o: "gt", f1v: "5", sort: "sessions", dir: "asc" });
  });
  it("CSV cells are escaped and safe to open in spreadsheets", () => {
    expect(csvCell('a,"b"')).toBe('"a,""b"""');
    expect(csvCell("=HYPERLINK(1)")).toBe("'=HYPERLINK(1)");
    expect(csvCell("-12.5")).toBe("-12.5");
  });
  it("GA4 table columns follow the chosen groups; older rows stored by position still show", () => {
    const named = JSON.stringify({ date: "20261101", sessionCampaignName: "(organic)", sessionSource: "google", sessions: "3" });
    const cols = rawColumnsFor("ga4", [named], ["traffic_sources"]);
    expect(cols.map((c) => c.label)).toEqual(["sessionCampaignId", "sessionCampaignName", "sessionSource", "sessionMedium", "sessionDefaultChannelGroup", "sessions", "keyEvents", "totalRevenue"]);
    expect(cols.find((c) => c.label === "sessions")!.path).toEqual(["sessions"]);
    const legacy = JSON.stringify({ dimensions: [{ value: "20261101" }], metrics: [{ value: "3" }] });
    expect(rawColumnsFor("ga4", [legacy], ["traffic_sources"]).find((c) => c.label === "sessions")!.path).toEqual(["metrics", "0", "value"]);
    expect(rawColumnsFor("csv", [JSON.stringify({ date: "2026-11-01", spend: 1 })]).map((c) => c.path)).toEqual([["date"], ["spend"]]);
  });
});

describe("BigQuery raw page query", () => {
  it("filters and sorts with parameters and validated JSON paths", async () => {
    const job = { getQueryResults: vi.fn().mockResolvedValue([[{ n: 3 }]]), metadata: { statistics: {} } };
    const client = { createQueryJob: vi.fn().mockResolvedValue([job]) };
    const wh = new BigQueryWarehouse(client as never, { maxBytesBilled: 1000, billingApproved: true });
    const ref = { provider: "bigquery" as const, projectId: "mip-dev-project", datasetId: "mip_dev_c_abc", location: "US" };
    await wh.queryRawPage(ref, {
      syncRunIds: ["r1"], source: "ga4", from: "2026-11-01", to: "2026-11-24",
      filters: [{ path: ["metrics", "0", "value"], op: "gt", value: "5" }, { path: ["sessionSource"], op: "contains", value: "goo" }],
      sort: { by: ["metrics", "0", "value"], dir: "asc" }, limit: 100, offset: 200,
    });
    const page = client.createQueryJob.mock.calls[1]![0];
    expect(page.query).toContain("JSON_VALUE(payload_json, '$.metrics[0].value')");
    expect(page.query).toContain("SAFE_CAST(JSON_VALUE(payload_json, '$.metrics[0].value') AS FLOAT64) > @f0");
    expect(page.query).toContain("STRPOS(LOWER(JSON_VALUE(payload_json, '$.sessionSource')), LOWER(@f1)) > 0");
    expect(page.params).toMatchObject({ f0: 5, f1: "goo", lim: 100, off: 200, from: { value: "2026-11-01" } });
    await expect(wh.queryRawPage(ref, { syncRunIds: ["r1"], filters: [{ path: ["a'; DROP"], op: "eq", value: "1" }], limit: 1, offset: 0 })).rejects.toMatchObject({ code: "invalid" });
  });
});

describe("displayValue", () => {
  it("shows durations as m:ss and long decimals rounded; the stored value is untouched elsewhere", async () => {
    const { displayValue } = await import("@/lib/rawTable");
    expect(displayValue("averageSessionDuration", "19.938517500000003")).toBe("0:20");
    expect(displayValue("averageSessionDuration", "1861.271757")).toBe("31:01");
    expect(displayValue("averageSessionDuration", "4778.86")).toBe("1:19:39");
    expect(displayValue("sessions", "12")).toBe("12");
    expect(displayValue("purchaseRevenue", "413.66852633333338")).toBe("413.67");
    expect(displayValue("sessionSource", "google")).toBe("google");
    expect(displayValue("x", "")).toBe("");
  });
});
