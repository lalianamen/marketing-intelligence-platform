import { GA4_SCOPE, type FetchLike, postJson, refreshAccessToken } from "./google";
import { ga4Fields } from "../../lib/ga4Catalog";
import { type Connector, ConnectorError, type FetchContext, type FetchResult, type ProviderDailyRecord } from "./types";

// GA4 LIVE connector — Google Analytics Data API v1beta `runReport`.
// MVP pathway: daily REPORT metrics per session campaign (not raw events).
//   dimensions: date, sessionCampaignName (+ sessionCampaignId when chosen)
//   metrics:    sessions, keyEvents, totalRevenue
// "keyEvents" are GA4 key events — reported as conversion_type 'ga4_key_event'
// and never summed with ad-platform conversions. totalRevenue is GA4-reported
// revenue → stored as attributed_revenue (not verified billed revenue).
// Raw-event analysis would use the GA4 BigQuery export instead (see docs).
// Status: implemented and unit-tested against mocked HTTP; NOT verified live.

const PAGE_SIZE = 10_000;

export function ga4Date(yyyymmdd: string): string {
  if (!/^\d{8}$/.test(yyyymmdd)) throw new ConnectorError("invalid_request", `ga4: unexpected date ${yyyymmdd}`);
  return `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;
}

interface Ga4Response {
  rows?: { dimensionValues: { value: string }[]; metricValues: { value: string }[] }[];
  rowCount?: number;
  metadata?: { currencyCode?: string; timeZone?: string; dataLossFromOtherRow?: boolean };
}

export class Ga4Connector implements Connector {
  readonly providerId = "ga4" as const;
  readonly origin = "ga4" as const;
  readonly mode = "live" as const;
  readonly requiredScopes = [GA4_SCOPE] as const;
  readonly finalizationDays = 3;
  readonly lookbackDays = 3;

  constructor(private readonly cfg: { clientId: string; clientSecret: string; fetch?: FetchLike }) {}

  async fetchDaily(ctx: FetchContext): Promise<FetchResult> {
    if (!ctx.credentials) throw new ConnectorError("auth_expired", "ga4: connection has no stored authorization");
    if (!/^\d{1,20}$/.test(ctx.externalAccountId)) throw new ConnectorError("invalid_request", "ga4: property id must be numeric");
    const f = this.cfg.fetch ?? fetch;
    const accessToken = await refreshAccessToken(this.cfg, ctx.credentials.refreshToken);
    // One request for the whole table: the base fields plus every group the user switched on.
    const fields = ga4Fields(ctx.options?.ga4Reports);
    let apiCalls = 1;
    const records: ProviderDailyRecord[] = [];
    const notes: string[] = [];
    let offset = 0;
    let total = Infinity;
    let complete = true;
    while (offset < total) {
      const { json, calls } = await postJson(
        f,
        `https://analyticsdata.googleapis.com/v1beta/properties/${ctx.externalAccountId}:runReport`,
        { authorization: `Bearer ${accessToken}` },
        {
          dateRanges: [{ startDate: ctx.window.from, endDate: ctx.window.to }],
          dimensions: fields.dimensions.map((name) => ({ name })),
          metrics: fields.metrics.map((name) => ({ name })),
          limit: PAGE_SIZE,
          offset,
          keepEmptyRows: false,
          returnPropertyQuota: true,
        },
        "ga4",
      );
      apiCalls += calls;
      const body = json as Ga4Response;
      total = body.rowCount ?? 0;
      const tz = body.metadata?.timeZone ?? ctx.companyTimezone;
      if (body.metadata?.dataLossFromOtherRow) {
        notes.push("GA4 grouped some low-volume rows into '(other)'; detail is partial for some days.");
      }
      for (const row of body.rows ?? []) {
        // Stored row: every requested field by name (the table shows exactly these columns).
        const values: Record<string, string> = {};
        fields.dimensions.forEach((d, i) => (values[d] = row.dimensionValues[i]?.value ?? ""));
        fields.metrics.forEach((m, i) => (values[m] = row.metricValues[i]?.value ?? ""));
        const num = (k: string) => {
          const n = Number(values[k]);
          return values[k] !== undefined && values[k] !== "" && Number.isFinite(n) ? n : null;
        };
        const campaignId = values.sessionCampaignId ?? "";
        const campaignName = values.sessionCampaignName ?? "";
        records.push({
          date: ga4Date(values.date ?? ""),
          account_id: ctx.externalAccountId,
          account_name: null,
          // Traffic without a campaign comes back as "(not set)" with the channel as the name
          // ("(organic)", "(direct)"…): keep those apart instead of merging them under one id.
          // Without the Campaign ID column, campaigns are told apart by name.
          campaign_id: !fields.dimensions.includes("sessionCampaignId")
            ? `name:${campaignName || "(not set)"}`
            : campaignId && campaignId !== "(not set)" ? campaignId : `(not set) ${campaignName}`.trim(),
          campaign_name: campaignName || null,
          currency: body.metadata?.currencyCode ?? null,
          timezone: tz,
          // Dashboard numbers: rows of one campaign (split by the extra breakdowns) are summed back.
          metrics: {
            impressions: null,
            clicks: null,
            spend: null,
            sessions: num("sessions"),
            conversions: num("keyEvents"),
            conversion_type: "ga4_key_event",
            leads: null,
            attributed_revenue: num("totalRevenue"),
            billed_revenue: null,
          },
          raw: values,
          rawKey: fields.dimensions.map((d) => values[d]).join("\u001f"),
        });
      }
      const got = body.rows?.length ?? 0;
      if (got === 0) break;
      offset += got;
      if (apiCalls > 50) {
        complete = false;
        notes.push("Stopped after 50 pages; the window may be incomplete.");
        break;
      }
    }
    if (records.length < total && Number.isFinite(total)) complete = false;
    return { records, apiCalls, complete, notes };
  }
}
