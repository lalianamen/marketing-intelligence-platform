import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { exchangeMetaCode, listMetaAdAccounts, MetaAdsConnector, metaDialogUrl, pickAction } from "@/server/connectors/meta";
import { normalizeProviderRecords } from "@/server/ingestion/normalize";
import { columnCatalog } from "@/lib/columnCatalog";
import { rawColumnsFor } from "@/lib/rawTable";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const APP = { appId: "123", appSecret: "app-secret", apiVersion: "v27.0", redirectUri: "https://app.example/api/oauth/meta/callback" };
const ctx = (columns: string[] = []) => ({
  window: { from: "2026-11-10", to: "2026-11-11" }, externalAccountId: "act_42", companyId: "c", companyTimezone: "UTC",
  credentials: { refreshToken: "user-token" }, now: new Date("2026-11-27T00:00:00Z"), options: { columns },
});
const row = (date: string, extra: Record<string, unknown> = {}) => ({
  date_start: date, date_stop: date, campaign_id: "9", campaign_name: "Spring", spend: "12.50", impressions: "1000", clicks: "40",
  actions: [{ action_type: "omni_purchase", value: "2" }, { action_type: "purchase", value: "2" }, { action_type: "lead", value: "3" }, { action_type: "link_click", value: "30" }],
  action_values: [{ action_type: "omni_purchase", value: "99.90" }, { action_type: "purchase", value: "99.90" }],
  ...extra,
});

describe("Meta Ads connector", () => {
  it("campaign × day in the ad account's currency and time zone; every page read; every call signed", async () => {
    const f = vi.fn()
      .mockResolvedValueOnce(json({ name: "LICENA ads", currency: "usd", timezone_name: "America/Los_Angeles" }))
      .mockResolvedValueOnce(json({ data: [row("2026-11-10")], paging: { next: "https://graph.facebook.com/v27.0/act_42/insights?after=x" } }))
      .mockResolvedValueOnce(json({ data: [row("2026-11-11", { spend: "0", impressions: "0", clicks: "0", actions: undefined, action_values: undefined })] }));
    const out = await new MetaAdsConnector({ ...APP, fetch: f }).fetchDaily(ctx());
    const insights = new URL(String(f.mock.calls[1]![0]));
    expect(insights.pathname).toBe("/v27.0/act_42/insights");
    expect(Object.fromEntries(insights.searchParams)).toMatchObject({
      level: "campaign", time_increment: "1", time_range: JSON.stringify({ since: "2026-11-10", until: "2026-11-11" }), use_unified_attribution_setting: "true",
      appsecret_proof: createHmac("sha256", "app-secret").update("user-token").digest("hex"),
    });
    expect(String(f.mock.calls[2]![0])).toContain("after=x");
    expect(out.apiCalls).toBe(3);
    const n = normalizeProviderRecords(out.records, { syncRunId: "r", origin: "meta_ads", isSimulated: false, today: "2026-11-27", finalizationDays: 7, now: new Date() });
    expect(n.normalized.map((r) => [r.metric_date, r.currency, r.spend, r.clicks, r.conversions, r.leads, r.attributed_revenue])).toEqual([
      ["2026-11-10", "USD", 12.5, 40, 2, 3, 99.9],
      ["2026-11-11", "USD", 0, 0, 0, 0, 0],
    ]);
    expect(n.normalized[0]!.source_timezone).toBe("America/Los_Angeles");
    expect(rawColumnsFor("meta_ads", [], []).map((c) => c.label)).toEqual(["campaign_id", "campaign_name", "spend", "impressions", "clicks", "purchases", "purchase_value", "leads"]);
  });

  it("with a breakdown: Facebook/Instagram rows go to the table only; the dashboard keeps campaign totals", async () => {
    const f = vi.fn()
      .mockResolvedValueOnce(json({ currency: "USD", timezone_name: "UTC" }))
      .mockResolvedValueOnce(json({ data: [row("2026-11-10")] }))
      .mockResolvedValueOnce(json({ data: [row("2026-11-10", { publisher_platform: "instagram", spend: "5" }), row("2026-11-10", { publisher_platform: "facebook", spend: "7.5" })] }));
    const out = await new MetaAdsConnector({ ...APP, fetch: f }).fetchDaily(ctx(["platform"]));
    expect(new URL(String(f.mock.calls[2]![0])).searchParams.get("breakdowns")).toBe("publisher_platform");
    const n = normalizeProviderRecords(out.records, { syncRunId: "r", origin: "meta_ads", isSimulated: false, today: "2026-11-27", finalizationDays: 7, now: new Date() });
    expect(n.normalized.map((r) => r.spend)).toEqual([12.5]);
    expect(out.records.filter((r) => r.role === "table").map((r) => [r.raw.platform, r.raw.spend])).toEqual([["instagram", 5], ["facebook", 7.5]]);
    expect(columnCatalog("meta_ads")!.problem(["platform", "country"])).toMatch(/at most 1 breakdowns/);
  });

  it("an expired sign-in is 'authorization expired'; rate limits are retried later", async () => {
    const expired = vi.fn().mockResolvedValueOnce(json({ error: { message: "Error validating access token", type: "OAuthException", code: 190, error_subcode: 463 } }, 400));
    await expect(new MetaAdsConnector({ ...APP, fetch: expired }).fetchDaily(ctx())).rejects.toMatchObject({ code: "auth_expired" });
    const limited = vi.fn().mockResolvedValueOnce(json({ error: { code: 80000, error_subcode: 2446079, message: "too many calls" } }, 400));
    await expect(new MetaAdsConnector({ ...APP, fetch: limited }).fetchDaily(ctx())).rejects.toMatchObject({ code: "rate_limited", retryable: true });
  });

  it("sign-in: dialog asks only ads_read; code → long-lived token; closed ad accounts are skipped", async () => {
    const dialog = new URL(metaDialogUrl(APP, "st8"));
    expect(dialog.origin + dialog.pathname).toBe("https://www.facebook.com/v27.0/dialog/oauth");
    expect(Object.fromEntries(dialog.searchParams)).toEqual({ client_id: "123", redirect_uri: APP.redirectUri, state: "st8", response_type: "code", scope: "ads_read" });
    expect(new URL(metaDialogUrl({ ...APP, configId: "cfg1" }, "s")).searchParams.get("config_id")).toBe("cfg1");
    const ex = vi.fn().mockResolvedValueOnce(json({ access_token: "short" })).mockResolvedValueOnce(json({ access_token: "long", expires_in: 5183944 }));
    expect(await exchangeMetaCode(ex, APP, "code1")).toBe("long");
    expect(new URL(String(ex.mock.calls[1]![0])).searchParams.get("grant_type")).toBe("fb_exchange_token");
    const list = vi.fn().mockResolvedValueOnce(json({ data: [
      { id: "act_1", name: "Main", currency: "USD", account_status: 1, business: { name: "LICENA" } },
      { id: "act_2", name: "Old", currency: "USD", account_status: 101 },
    ] }));
    expect(await listMetaAdAccounts(list, APP, "long")).toEqual([{ id: "act_1", name: "Main (USD)", group: "LICENA" }]);
    expect(pickAction([{ action_type: "purchase", value: "4" }, { action_type: "offsite_conversion.fb_pixel_purchase", value: "4" }], ["omni_purchase", "purchase", "offsite_conversion.fb_pixel_purchase"])).toBe(4);
  });
});
