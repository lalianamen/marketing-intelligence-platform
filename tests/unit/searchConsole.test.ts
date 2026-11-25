import { describe, expect, it, vi } from "vitest";
import { isSearchConsoleSite, listSearchConsoleSites, SearchConsoleConnector } from "@/server/connectors/searchConsole";
import { normalizeProviderRecords } from "@/server/ingestion/normalize";
import { columnCatalog } from "@/lib/columnCatalog";
import { rawColumnsFor } from "@/lib/rawTable";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const ctx = {
  window: { from: "2026-11-01", to: "2026-11-02" },
  companyId: "c",
  companyTimezone: "America/Los_Angeles",
  credentials: { refreshToken: "1//rt" },
  now: new Date("2026-11-25T12:00:00Z"),
  externalAccountId: "sc-domain:licena.us",
};

describe("Search Console connector", () => {
  it("dashboard numbers come from per-day totals; table rows carry the chosen columns", async () => {
    const f = vi.fn()
      .mockResolvedValueOnce(json(200, { access_token: "ya29" }))
      .mockResolvedValueOnce(json(200, { rows: [{ keys: ["2026-11-01"], clicks: 100, impressions: 2000, ctr: 0.05, position: 8.2 }] }))
      .mockResolvedValueOnce(json(200, { rows: [
        { keys: ["2026-11-01", "ac repair los angeles", "MOBILE"], clicks: 40, impressions: 500, ctr: 0.08, position: 3.1 },
        { keys: ["2026-11-01", "hvac near me", "DESKTOP"], clicks: 20, impressions: 700, ctr: 0.03, position: 6 },
      ] }));
    const c = new SearchConsoleConnector({ clientId: "id", clientSecret: "s", fetch: f });
    const out = await c.fetchDaily({ ...ctx, options: { columns: ["query", "device"] } });

    expect(String(f.mock.calls[1]![0])).toBe("https://www.googleapis.com/webmasters/v3/sites/sc-domain%3Alicena.us/searchAnalytics/query");
    expect(JSON.parse((f.mock.calls[1]![1] as RequestInit).body as string)).toMatchObject({ dimensions: ["date"], type: "web", dataState: "all" });
    expect(JSON.parse((f.mock.calls[2]![1] as RequestInit).body as string).dimensions).toEqual(["date", "query", "device"]);

    const n = normalizeProviderRecords(out.records, { syncRunId: "r", origin: "google_search_console", isSimulated: false, today: "2026-11-25", finalizationDays: 3, now: ctx.now });
    expect(n.normalized.map((r) => [r.metric_date, r.clicks, r.impressions])).toEqual([["2026-11-01", 100, 2000]]); // not 60: hidden queries count too
    expect(n.raw.map((r) => JSON.parse(r.payload_json))).toEqual([
      { date: "2026-11-01", query: "ac repair los angeles", device: "MOBILE", clicks: "40", impressions: "500", ctr: "0.08", position: "3.1" },
      { date: "2026-11-01", query: "hvac near me", device: "DESKTOP", clicks: "20", impressions: "700", ctr: "0.03", position: "6" },
    ]);
    expect(out.notes.join(" ")).toMatch(/hides rare search queries/);
  });

  it("without breakdowns the daily totals are both the table and the dashboard", async () => {
    const f = vi.fn().mockResolvedValueOnce(json(200, { access_token: "ya29" })).mockResolvedValueOnce(json(200, { rows: [{ keys: ["2026-11-01"], clicks: 5, impressions: 50, ctr: 0.1, position: 4 }] }));
    const out = await new SearchConsoleConnector({ clientId: "id", clientSecret: "s", fetch: f }).fetchDaily(ctx);
    expect(f).toHaveBeenCalledTimes(2);
    const n = normalizeProviderRecords(out.records, { syncRunId: "r", origin: "google_search_console", isSimulated: false, today: "2026-11-25", finalizationDays: 3, now: ctx.now });
    expect(n.normalized).toHaveLength(1);
    expect(n.raw).toHaveLength(1);
  });

  it("lists verified sites only; site ids are validated", async () => {
    const f = vi.fn().mockResolvedValueOnce(json(200, { siteEntry: [
      { siteUrl: "sc-domain:licena.us", permissionLevel: "siteOwner" },
      { siteUrl: "https://licena.us/", permissionLevel: "siteFullUser" },
      { siteUrl: "https://other.com/", permissionLevel: "siteUnverifiedUser" },
    ] }));
    expect(await listSearchConsoleSites("t", f)).toEqual([
      { id: "sc-domain:licena.us", name: "licena.us (whole domain)", group: null },
      { id: "https://licena.us/", name: "https://licena.us/", group: null },
    ]);
    expect(isSearchConsoleSite("sc-domain:licena.us")).toBe(true);
    expect(isSearchConsoleSite("javascript:alert(1)")).toBe(false);
  });

  it("the table shows the chosen columns, same model as GA4", () => {
    const cat = columnCatalog("google_search_console")!;
    expect(cat.fields(["pages", "device"])).toEqual({ dimensions: ["date", "page", "device"], metrics: ["clicks", "impressions", "ctr", "position"] });
    expect(cat.problem(["queries", "pages", "countries", "devices"])).toBeNull(); // no 9-column limit here
    expect(rawColumnsFor("google_search_console", [], ["query"]).map((c) => c.label)).toEqual(["query", "clicks", "impressions", "ctr", "position"]);
  });
});
