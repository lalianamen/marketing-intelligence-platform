import { GA4_SCOPE, type FetchLike, postJson, refreshAccessToken } from "./google";
import { GA4_DIMENSIONS, GA4_METRICS } from "../../lib/rawView";
import { ga4ReportById, sanitizeGa4Reports } from "../../lib/ga4Catalog";
import { type Connector, ConnectorError, type ExtraRawRecord, type FetchContext, type FetchResult, type ProviderDailyRecord } from "./types";

// GA4 LIVE connector — Google Analytics Data API v1beta `runReport`.
// MVP pathway: daily REPORT metrics per session campaign (not raw events).
//   dimensions: date, sessionCampaignId, sessionCampaignName
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
          dimensions: GA4_DIMENSIONS.map((name) => ({ name })),
          metrics: GA4_METRICS.map((name) => ({ name })),
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
        notes.push("GA4 grouped some low-volume rows into '(other)'; campaign detail is partial for some days.");
      }
      for (const row of body.rows ?? []) {
        const [date, campaignId, campaignName] = row.dimensionValues.map((d) => d.value);
        const [sessions, keyEvents, revenue] = row.metricValues.map((m) => Number(m.value));
        records.push({
          date: ga4Date(date!),
          account_id: ctx.externalAccountId,
          account_name: null,
          // Traffic without a campaign comes back as "(not set)" with the channel as the name
          // ("(organic)", "(direct)"…): keep those apart instead of merging them under one id.
          campaign_id: campaignId && campaignId !== "(not set)" ? campaignId : `(not set) ${campaignName ?? ""}`.trim(),
          campaign_name: campaignName || null,
          currency: body.metadata?.currencyCode ?? null,
          timezone: tz,
          metrics: {
            impressions: null,
            clicks: null,
            spend: null,
            sessions: Number.isFinite(sessions) ? sessions! : null,
            conversions: Number.isFinite(keyEvents) ? keyEvents! : null,
            conversion_type: "ga4_key_event",
            leads: null,
            attributed_revenue: Number.isFinite(revenue) ? revenue! : null,
            billed_revenue: null,
          },
          raw: { dimensions: row.dimensionValues, metrics: row.metricValues },
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

    // Extra reports the user switched on. Each one is independent: a failure (e.g. Google Ads
    // not linked, quota) is reported and skipped, so the dashboard data still arrives.
    const extraRaw: ExtraRawRecord[] = [];
    const extraErrors: { report: string; message: string }[] = [];
    const extraFetched: string[] = [];
    for (const id of sanitizeGa4Reports(ctx.options?.ga4Reports)) {
      const report = ga4ReportById(id)!;
      try {
        const out = await this.runExtraReport(f, accessToken, ctx, report.id, report.dimensions.map((d) => d.name), report.metrics.map((m) => m.name));
        apiCalls += out.calls;
        if (out.complete) extraFetched.push(report.id);
        else extraErrors.push({ report: report.id, message: "row limit reached; the report may be incomplete" });
        extraRaw.push(...out.rows);
      } catch (err) {
        if (err instanceof ConnectorError && err.code === "auth_expired") throw err;
        extraErrors.push({ report: report.id, message: (err as Error).message.slice(0, 300) });
      }
    }
    return { records, apiCalls, complete, notes, extraRaw, extraErrors, extraFetched };
  }

  private async runExtraReport(
    f: FetchLike,
    accessToken: string,
    ctx: FetchContext,
    id: string,
    dimensions: string[],
    metrics: string[],
  ): Promise<{ rows: ExtraRawRecord[]; calls: number; complete: boolean }> {
    const rows: ExtraRawRecord[] = [];
    let offset = 0;
    let total = Infinity;
    let calls = 0;
    while (offset < total) {
      const { json, calls: c } = await postJson(
        f,
        `https://analyticsdata.googleapis.com/v1beta/properties/${ctx.externalAccountId}:runReport`,
        { authorization: `Bearer ${accessToken}` },
        {
          dateRanges: [{ startDate: ctx.window.from, endDate: ctx.window.to }],
          dimensions: dimensions.map((name) => ({ name })),
          metrics: metrics.map((name) => ({ name })),
          limit: PAGE_SIZE,
          offset,
          keepEmptyRows: false,
        },
        "ga4",
      );
      calls += c;
      const body = json as Ga4Response;
      total = body.rowCount ?? 0;
      for (const row of body.rows ?? []) {
        const payload: Record<string, string> = {};
        dimensions.forEach((d, i) => (payload[d] = row.dimensionValues[i]?.value ?? ""));
        metrics.forEach((m, i) => (payload[m] = row.metricValues[i]?.value ?? ""));
        rows.push({ source: `ga4:${id}`, date: ga4Date(payload.date!), key: dimensions.slice(1).map((d) => payload[d]).join("\u001f"), payload });
      }
      const got = body.rows?.length ?? 0;
      if (got === 0) break;
      offset += got;
      if (calls > 20) return { rows, calls, complete: false };
    }
    return { rows, calls, complete: rows.length >= total || !Number.isFinite(total) };
  }
}
