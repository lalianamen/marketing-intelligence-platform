import { describe, expect, it, vi } from "vitest";
import { ClarityConnector, clarityRows } from "@/server/connectors/clarity";
import { normalizeProviderRecords } from "@/server/ingestion/normalize";
import { columnCatalog } from "@/lib/columnCatalog";
import { rawColumnsFor } from "@/lib/rawTable";

const answer = [
  { metricName: "Traffic", information: [
    { totalSessionCount: "120", totalBotSessionCount: "4", distantUserCount: "90", PagesPerSessionPercentage: 2.1, Device: "Mobile", "Country/Region": "United States" },
    { totalSessionCount: "30", totalBotSessionCount: "0", distantUserCount: "25", PagesPerSessionPercentage: 1.4, Device: "PC", "Country/Region": "United States" },
  ] },
  { metricName: "Scroll Depth", information: [{ averageScrollDepth: 55.2, Device: "Mobile", "Country/Region": "United States" }] },
];

describe("Microsoft Clarity connector", () => {
  it("one request with the chosen breakdowns; every number Clarity returns is kept, grouped by metric", async () => {
    const f = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(answer), { status: 200 }));
    const c = new ClarityConnector({ fetch: f });
    const out = await c.fetchDaily({
      window: { from: "2026-11-24", to: "2026-11-24" }, externalAccountId: "abc123xyz", companyId: "c", companyTimezone: "America/Los_Angeles",
      credentials: { refreshToken: "token-value-123456789" }, now: new Date("2026-11-25T08:30:00Z"), options: { columns: ["device", "country"] },
    });
    const url = new URL(String(f.mock.calls[0]![0]));
    expect(Object.fromEntries(url.searchParams)).toEqual({ numOfDays: "1", dimension1: "Device", dimension2: "Country/Region" });
    expect(((f.mock.calls[0]![1] as RequestInit).headers as Record<string, string>).authorization).toBe("Bearer token-value-123456789");

    const n = normalizeProviderRecords(out.records, { syncRunId: "r", origin: "microsoft_clarity", isSimulated: false, today: "2026-11-25", finalizationDays: 0, now: new Date() });
    expect(n.normalized).toHaveLength(1);
    expect(n.normalized[0]).toMatchObject({ metric_date: "2026-11-24", sessions: null, clicks: null }); // never added to dashboard totals
    const rows = n.raw.map((r) => JSON.parse(r.payload_json));
    expect(rows[0]).toEqual({ date: "2026-11-24", device: "Mobile", country: "United States", Traffic: { totalSessionCount: "120", totalBotSessionCount: "4", distantUserCount: "90", PagesPerSessionPercentage: 2.1 }, ScrollDepth: { averageScrollDepth: 55.2 } });
    expect(rows).toHaveLength(2);
    expect(rawColumnsFor("microsoft_clarity", n.raw.map((r) => r.payload_json), ["device", "country"]).map((c) => c.label)).toEqual([
      "device", "country", "Traffic.totalSessionCount", "Traffic.totalBotSessionCount", "Traffic.distantUserCount", "Traffic.PagesPerSessionPercentage", "ScrollDepth.averageScrollDepth",
    ]);
  });

  it("Clarity's limits: at most 3 breakdowns; the daily request limit is a clear error", async () => {
    const cat = columnCatalog("microsoft_clarity")!;
    expect(cat.problem(["source", "medium", "device"])).toBeNull();
    expect(cat.problem(["source", "medium", "device", "url"])).toMatch(/at most 3 breakdowns/);
    const f = vi.fn().mockResolvedValueOnce(new Response("Exceeded daily limit", { status: 429 }));
    await expect(new ClarityConnector({ fetch: f }).fetchDaily({
      window: { from: "2026-11-24", to: "2026-11-24" }, externalAccountId: "abc123xyz", companyId: "c", companyTimezone: "UTC",
      credentials: { refreshToken: "t".repeat(30) }, now: new Date(),
    })).rejects.toMatchObject({ code: "quota_exceeded" });
    expect(clarityRows([], [])).toEqual([]);
  });

  it("dimension keys in the answer are matched ignoring case and punctuation", () => {
    const rows = clarityRows([{ metricName: "Traffic", information: [{ totalSessionCount: "3", Url: "https://licena.us/pricing", CountryRegion: "United States" }] }], ["url", "country"]);
    expect(rows).toEqual([{ url: "https://licena.us/pricing", country: "United States", Traffic: { totalSessionCount: "3" } }]);
  });
});
