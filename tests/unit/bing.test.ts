import { describe, expect, it, vi } from "vitest";
import { BingWebmasterConnector, bingDate, bingKeyProblem, exchangeBingCode, listBingSites, sameBingSite } from "@/server/connectors/bing";
import { normalizeProviderRecords } from "@/server/ingestion/normalize";
import { columnCatalog } from "@/lib/columnCatalog";
import { rawColumnsFor } from "@/lib/rawTable";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
// Bing's .NET dates: midnight in Bing's offset.
const day = (iso: string) => `/Date(${Date.parse(`${iso}T00:00:00-08:00`)}-0800)/`;
const KEY = "0123456789abcdef0123456789abcdef";
const ctx = (columns: string[] = []) => ({
  window: { from: "2026-11-10", to: "2026-11-11" }, externalAccountId: "https://licena.us/", companyId: "c", companyTimezone: "America/Los_Angeles",
  credentials: { refreshToken: KEY }, now: new Date("2026-11-27T00:00:00Z"), options: { columns },
});

describe("Bing Webmaster Tools connector", () => {
  it("daily totals of the window feed the dashboard; the key and site go in the query string", async () => {
    const f = vi.fn().mockResolvedValueOnce(json({ d: [
      { __type: "RankAndTrafficStats:#Microsoft.Bing.Webmaster.Api", Date: day("2026-11-09"), Clicks: 1, Impressions: 10 },
      { __type: "RankAndTrafficStats:#Microsoft.Bing.Webmaster.Api", Date: day("2026-11-10"), Clicks: 3, Impressions: 40 },
      { __type: "RankAndTrafficStats:#Microsoft.Bing.Webmaster.Api", Date: day("2026-11-11"), Clicks: 2, Impressions: 25 },
    ] }));
    const out = await new BingWebmasterConnector({ fetch: f }).fetchDaily(ctx());
    const url = new URL(String(f.mock.calls[0]![0]));
    expect(url.pathname).toBe("/webmaster/api.svc/json/GetRankAndTrafficStats");
    expect(Object.fromEntries(url.searchParams)).toEqual({ siteUrl: "https://licena.us/", apikey: KEY });
    expect(out.apiCalls).toBe(1);
    const n = normalizeProviderRecords(out.records, { syncRunId: "r", origin: "bing_webmaster", isSimulated: false, today: "2026-11-27", finalizationDays: 3, now: new Date() });
    expect(n.normalized.map((r) => [r.metric_date, r.clicks, r.impressions])).toEqual([["2026-11-10", 3, 40], ["2026-11-11", 2, 25]]);
    expect(n.raw.map((r) => JSON.parse(r.payload_json))[0]).toEqual({ date: "2026-11-10", clicks: 3, impressions: 40, avg_click_position: null, avg_impression_position: null });
  });

  it("with queries chosen: top-query rows go to the table only; the dashboard keeps the day totals", async () => {
    const f = vi.fn()
      .mockResolvedValueOnce(json({ d: [{ Date: day("2026-11-10"), Clicks: 5, Impressions: 80 }] }))
      .mockResolvedValueOnce(json({ d: [
        { Date: day("2026-11-10"), Query: "nevada c-3 exam", Clicks: 2, Impressions: 30, AvgClickPosition: 4, AvgImpressionPosition: 6 },
        { Date: day("2026-11-01"), Query: "old week", Clicks: 9, Impressions: 9, AvgClickPosition: 1, AvgImpressionPosition: 1 },
      ] }));
    const out = await new BingWebmasterConnector({ fetch: f }).fetchDaily(ctx(["query"]));
    expect(new URL(String(f.mock.calls[1]![0])).pathname).toBe("/webmaster/api.svc/json/GetQueryStats");
    const n = normalizeProviderRecords(out.records, { syncRunId: "r", origin: "bing_webmaster", isSimulated: false, today: "2026-11-27", finalizationDays: 3, now: new Date() });
    expect(n.normalized.map((r) => [r.metric_date, r.clicks, r.impressions])).toEqual([["2026-11-10", 5, 80]]);
    const table = out.records.filter((r) => r.role === "table").map((r) => r.raw);
    expect(table).toEqual([{ date: "2026-11-10", query: "nevada c-3 exam", clicks: 2, impressions: 30, avg_click_position: 4, avg_impression_position: 6 }]);
    expect(rawColumnsFor("bing_webmaster", [], ["query"]).map((c) => c.label)).toEqual(["query", "clicks", "impressions", "avg_click_position", "avg_impression_position"]);
    expect(out.notes.join(" ")).toMatch(/top queries/);
  });

  it("only one breakdown; a wrong key is 'authorization expired'; sites and dates are read as Bing gives them", async () => {
    const cat = columnCatalog("bing_webmaster")!;
    expect(cat.problem(["query"])).toBeNull();
    expect(cat.problem(["query", "page"])).toMatch(/at most 1 breakdowns/);
    const bad = vi.fn().mockResolvedValueOnce(json({ ErrorCode: 3, Message: "ERROR!!! InvalidApiKey" }, 400));
    await expect(new BingWebmasterConnector({ fetch: bad }).fetchDaily(ctx())).rejects.toMatchObject({ code: "auth_expired" });
    const sites = vi.fn().mockResolvedValueOnce(json({ d: [{ Url: "https://licena.us/", IsVerified: true }, { Url: "https://other.com/", IsVerified: false }] }));
    expect(await listBingSites(sites, { key: KEY })).toEqual(["https://licena.us/"]);
    expect(bingDate("/Date(1316156400000-0700)/")).toBe("2011-09-16");
    expect(bingDate("/Date(1316156400000)/")).toBe("2011-09-16");
    expect(bingDate("2011-09-16")).toBeNull();
    expect(sameBingSite("licena.us", "https://www.licena.us/")).toBe(true);
    expect(bingKeyProblem(KEY)).toBeNull();
    expect(bingKeyProblem("not a key")).toMatch(/does not look like/);
  });
});

describe("Bing Webmaster Tools: sign in with Bing", () => {
  it("a stored sign-in gets a fresh access token, then calls the API with a bearer token (no key in the URL)", async () => {
    const f = vi.fn()
      .mockResolvedValueOnce(json({ access_token: "access-1", expires_in: 3599, token_type: "Bearer" }))
      .mockResolvedValueOnce(json({ d: [{ Date: day("2026-11-10"), Clicks: 1, Impressions: 2 }] }));
    const c = new BingWebmasterConnector({ fetch: f, oauth: { clientId: "cid", clientSecret: "csecret" } });
    const out = await c.fetchDaily({ ...ctx(), credentials: { refreshToken: "oauth:refresh-1" } });
    expect(String(f.mock.calls[0]![0])).toBe("https://www.bing.com/webmasters/oauth/token");
    expect(Object.fromEntries(new URLSearchParams(String((f.mock.calls[0]![1] as RequestInit).body)))).toEqual({
      client_id: "cid", client_secret: "csecret", grant_type: "refresh_token", refresh_token: "refresh-1",
    });
    const api = new URL(String(f.mock.calls[1]![0]));
    expect(api.origin + api.pathname).toBe("https://www.bing.com/webmaster/api.svc/json/GetRankAndTrafficStats");
    expect(api.searchParams.get("apikey")).toBeNull();
    expect(((f.mock.calls[1]![1] as RequestInit).headers as Record<string, string>).authorization).toBe("Bearer access-1");
    expect(out.apiCalls).toBe(2);
  });

  it("a revoked sign-in is 'authorization expired'; the code exchange keeps the refresh token", async () => {
    const revoked = vi.fn().mockResolvedValueOnce(json({ error: "invalid_grant" }, 400));
    await expect(new BingWebmasterConnector({ fetch: revoked, oauth: { clientId: "a", clientSecret: "b" } }).fetchDaily({ ...ctx(), credentials: { refreshToken: "oauth:x" } }))
      .rejects.toMatchObject({ code: "auth_expired" });
    const badToken = vi.fn().mockResolvedValueOnce(json({ ErrorCode: 18, Message: "ERROR!!! InvalidToken" }, 400));
    await expect(listBingSites(badToken, { accessToken: "t" })).rejects.toMatchObject({ code: "auth_expired" });
    const ex = vi.fn().mockResolvedValueOnce(json({ access_token: "a1", refresh_token: "r1", expires_in: 3599 }));
    expect(await exchangeBingCode(ex, { clientId: "a", clientSecret: "b", redirectUri: "https://app/cb" }, "code1")).toEqual({ refreshToken: "r1", accessToken: "a1" });
    expect(new URLSearchParams(String((ex.mock.calls[0]![1] as RequestInit).body)).get("grant_type")).toBe("authorization_code");
  });
});
