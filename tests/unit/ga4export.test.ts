import { describe, expect, it, vi } from "vitest";
import { Ga4Connector } from "@/server/connectors/ga4";
import { addPropertyEditor, createBigQueryLink } from "@/server/connectors/ga4Admin";
import { exportTableDate, ga4ExportSql } from "@/server/ga4export/sql";
import { BigQueryWarehouse } from "@/server/warehouse/bigquery";
import type { DatasetRef } from "@/server/warehouse/types";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const ctx = {
  companyId: "c",
  companyTimezone: "America/Los_Angeles",
  credentials: { refreshToken: "1//rt" },
  now: new Date("2026-12-01T12:00:00Z"),
  externalAccountId: "123456",
};

describe("GA4 export SQL", () => {
  it("groups visits by any number of columns; unknown columns are refused", () => {
    const dims = ["date", "sessionCampaignName", "sessionSource", "sessionMedium", "sessionDefaultChannelGroup", "deviceCategory", "operatingSystem", "browser", "country", "region", "city", "language", "landingPage"];
    const sql = ga4ExportSql("`p.analytics_1.events_*`", { dimensions: dims, metrics: ["sessions", "keyEvents", "totalUsers", "averageSessionDuration"] });
    expect(sql).toContain("FROM `p.analytics_1.events_*`");
    expect(sql).toContain("GROUP BY 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13"); // 13 breakdowns: more than the Data API allows
    expect(sql).toContain("COUNT(*) AS sessions");
    expect(sql).toContain("IN UNNEST(@key_events)");
    expect(() => ga4ExportSql("`t`", { dimensions: ["date; DROP"], metrics: [] })).toThrow(/unknown column/);
    expect(() => ga4ExportSql("`t`", { dimensions: ["date"], metrics: ["bogus"] })).toThrow(/unknown number/);
    expect(exportTableDate("events_20261125")).toBe("2026-11-25");
    expect(exportTableDate("events_intraday_20261125")).toBeNull();
  });

  it("the BigQuery reader passes the window, one day earlier for visits that started before midnight, and key events", async () => {
    const job = { getQueryResults: vi.fn().mockResolvedValue([[{ date: "20261120", sessions: 3 }]]), metadata: { statistics: {} } };
    const client = { createQueryJob: vi.fn().mockResolvedValue([job]), dataset: vi.fn() };
    const wh = new BigQueryWarehouse(client as never, { maxBytesBilled: 1000, billingApproved: true });
    const ref: DatasetRef = { provider: "bigquery", projectId: "mkt-platform-prod-2", datasetId: "analytics_123456", location: "US" };
    const out = await wh.queryGa4Export(ref, { range: { from: "2026-11-20", to: "2026-11-21" }, dimensions: ["date"], metrics: ["sessions"], keyEvents: ["generate_lead", "bad name"] });
    expect(out.rows).toEqual([{ date: "20261120", sessions: "3" }]);
    const opts = client.createQueryJob.mock.calls[0]![0];
    expect(opts.query).toContain("`mkt-platform-prod-2.analytics_123456.events_*`");
    expect(opts.params.from_suffix).toBe("20261119");
    expect(opts.params.to_suffix).toBe("20261121");
    expect(opts.params.key_events).toEqual(["generate_lead"]);
    expect(opts.maximumBytesBilled).toBe("1000");
  });
});

describe("GA4 connector with the export", () => {
  const apiRow = { dimensionValues: [{ value: "20261118" }, { value: "(organic)" }], metricValues: ["5", "0", "0"].map((value) => ({ value })) };

  it("exported days come from BigQuery, earlier days from the Data API", async () => {
    const f = vi.fn().mockResolvedValueOnce(json(200, { access_token: "ya29" })).mockResolvedValueOnce(json(200, { rowCount: 1, metadata: {}, rows: [apiRow] }));
    const query = vi.fn().mockResolvedValue([{ date: "20261120", sessionCampaignName: "(organic)", sessions: "7", keyEvents: "1", totalRevenue: "0" }]);
    const c = new Ga4Connector({ clientId: "id", clientSecret: "s", fetch: f });
    const out = await c.fetchDaily({ ...ctx, window: { from: "2026-11-18", to: "2026-11-21" }, ga4Export: { first: "2026-11-20", last: "2026-11-25", query } });
    expect(query).toHaveBeenCalledWith({ from: "2026-11-20", to: "2026-11-21" }, expect.objectContaining({ dimensions: ["date", "sessionCampaignName"] }));
    const body = JSON.parse((f.mock.calls[1]![1] as RequestInit).body as string);
    expect(body.dateRanges).toEqual([{ startDate: "2026-11-18", endDate: "2026-11-19" }]);
    expect(out.records.map((r) => [r.date, r.metrics.sessions])).toEqual([["2026-11-20", 7], ["2026-11-18", 5]]);
  });

  it("with more columns than the Data API allows, only exported days load; the rest is reported, not guessed", async () => {
    const f = vi.fn();
    const query = vi.fn().mockResolvedValue([]);
    const c = new Ga4Connector({ clientId: "id", clientSecret: "s", fetch: f });
    const out = await c.fetchDaily({
      ...ctx,
      window: { from: "2026-11-18", to: "2026-11-21" },
      options: { ga4Reports: ["traffic_sources", "devices", "geo"] }, // 12 breakdowns
      ga4Export: { first: "2026-11-20", last: "2026-11-25", query },
    });
    expect(f).not.toHaveBeenCalled();
    expect(out.complete).toBe(true);
    expect(out.notes.join(" ")).toMatch(/2026-11-18 – 2026-11-19 were not loaded/);
  });
});

describe("GA4 Admin API requests", () => {
  it("adds the service account as Editor and creates a daily export link without advertising ids", async () => {
    const f = vi.fn().mockResolvedValueOnce(json(200, { name: "properties/1/accessBindings/abc" })).mockResolvedValueOnce(json(200, { name: "properties/1/bigQueryLinks/x", project: "projects/42" }));
    expect(await addPropertyEditor(f, "user-token", "1", "mip@proj.iam.gserviceaccount.com")).toBe("properties/1/accessBindings/abc");
    expect(String(f.mock.calls[0]![0])).toBe("https://analyticsadmin.googleapis.com/v1alpha/properties/1/accessBindings");
    expect(JSON.parse((f.mock.calls[0]![1] as RequestInit).body as string)).toEqual({ user: "mip@proj.iam.gserviceaccount.com", roles: ["predefinedRoles/editor"] });
    await createBigQueryLink(f, "sa-token", "1", "mkt-platform-prod-2", "US");
    const link = JSON.parse((f.mock.calls[1]![1] as RequestInit).body as string);
    expect(link).toMatchObject({ project: "projects/mkt-platform-prod-2", dailyExportEnabled: true, streamingExportEnabled: false, includeAdvertisingId: false, datasetLocation: "US" });
    expect(((f.mock.calls[1]![1] as RequestInit).headers as Record<string, string>).authorization).toBe("Bearer sa-token");
  });
});
