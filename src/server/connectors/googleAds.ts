import { GOOGLE_ADS_SCOPE, type FetchLike, postJson, refreshAccessToken } from "./google";
import { type Connector, ConnectorError, type FetchContext, type FetchResult, type ProviderDailyRecord } from "./types";

// GOOGLE ADS LIVE connector — Google Ads API REST `googleAds:searchStream` (GAQL).
// Grain: campaign x day (segments.date) in the ACCOUNT's time zone and currency.
// Metrics: impressions, clicks, cost_micros → spend, conversions (ad-platform,
// per the account's conversion settings), conversions_value → attributed revenue.
// Access: OAuth scope adwords + a Google Cloud project with Google Ads API
// access. An OAuth login alone does not grant report access: the signed-in
// user must have access to the customer account; manager access needs
// login-customer-id. Status: implemented and unit-tested against mocked HTTP;
// NOT verified live.

export function buildGaql(from: string, to: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) throw new Error("invalid dates");
  return [
    "SELECT segments.date, customer.id, customer.descriptive_name, customer.currency_code, customer.time_zone,",
    "campaign.id, campaign.name, metrics.impressions, metrics.clicks, metrics.cost_micros,",
    "metrics.conversions, metrics.conversions_value",
    "FROM campaign",
    `WHERE segments.date BETWEEN '${from}' AND '${to}'`,
  ].join(" ");
}

interface AdsRow {
  segments?: { date?: string };
  customer?: { id?: string; descriptiveName?: string; currencyCode?: string; timeZone?: string };
  campaign?: { id?: string; name?: string };
  metrics?: { impressions?: string; clicks?: string; costMicros?: string; conversions?: number; conversionsValue?: number };
}

export class GoogleAdsConnector implements Connector {
  readonly providerId = "google_ads" as const;
  readonly origin = "google_ads" as const;
  readonly mode = "live" as const;
  readonly requiredScopes = [GOOGLE_ADS_SCOPE] as const;
  // Conversions can be attributed back to the click date for the length of the
  // conversion window, so recent days are re-fetched and marked preliminary.
  readonly finalizationDays = 14;
  readonly lookbackDays = 14;

  constructor(
    private readonly cfg: {
      clientId: string;
      clientSecret: string;
      apiVersion: string;
      developerToken?: string;
      loginCustomerId?: string;
      fetch?: FetchLike;
    },
  ) {}

  async fetchDaily(ctx: FetchContext): Promise<FetchResult> {
    if (!ctx.credentials) throw new ConnectorError("auth_expired", "google_ads: connection has no stored authorization");
    const customerId = ctx.externalAccountId.replace(/-/g, "");
    if (!/^\d{10}$/.test(customerId)) throw new ConnectorError("invalid_request", "google_ads: customer id must be 10 digits");
    if (!/^v\d{1,3}$/.test(this.cfg.apiVersion)) throw new ConnectorError("not_configured", "google_ads: invalid API version");
    const f = this.cfg.fetch ?? fetch;
    const accessToken = await refreshAccessToken(this.cfg, ctx.credentials.refreshToken);
    const headers: Record<string, string> = { authorization: `Bearer ${accessToken}` };
    if (this.cfg.developerToken) headers["developer-token"] = this.cfg.developerToken;
    if (this.cfg.loginCustomerId) headers["login-customer-id"] = this.cfg.loginCustomerId.replace(/-/g, "");

    const { json, calls } = await postJson(
      f,
      `https://googleads.googleapis.com/${this.cfg.apiVersion}/customers/${customerId}/googleAds:searchStream`,
      headers,
      { query: buildGaql(ctx.window.from, ctx.window.to) },
      "google_ads",
    );
    const batches = (Array.isArray(json) ? json : [json]) as { results?: AdsRow[] }[];
    const records: ProviderDailyRecord[] = [];
    for (const batch of batches) {
      for (const r of batch.results ?? []) {
        if (!r.segments?.date || !r.campaign?.id) continue;
        const costMicros = r.metrics?.costMicros !== undefined ? Number(r.metrics.costMicros) : null;
        records.push({
          date: r.segments.date,
          account_id: customerId,
          account_name: r.customer?.descriptiveName ?? null,
          campaign_id: String(r.campaign.id),
          campaign_name: r.campaign.name ?? null,
          currency: r.customer?.currencyCode ?? null,
          timezone: r.customer?.timeZone ?? ctx.companyTimezone,
          metrics: {
            impressions: r.metrics?.impressions !== undefined ? Number(r.metrics.impressions) : 0,
            clicks: r.metrics?.clicks !== undefined ? Number(r.metrics.clicks) : 0,
            spend: costMicros === null ? 0 : costMicros / 1_000_000,
            sessions: null,
            conversions: r.metrics?.conversions ?? 0,
            conversion_type: "ad_platform_conversion",
            leads: null,
            attributed_revenue: r.metrics?.conversionsValue ?? 0,
            billed_revenue: null,
          },
          raw: r as Record<string, unknown>,
        });
      }
    }
    // searchStream returns the complete result set for the query or fails.
    return { records, apiCalls: calls + 1, complete: true, notes: [] };
  }
}
