import { GA4_SCOPE, type FetchLike, postJson, refreshAccessToken } from "./google";
import { ga4Fields, ga4SelectionProblem } from "../../lib/ga4Catalog";
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
    const fields = ga4Fields(ctx.options?.ga4Reports);
    const records: ProviderDailyRecord[] = [];
    const notes: string[] = [];
    let apiCalls = 0;
    let complete = true;

    // Days GA4 has already exported to BigQuery come from there (full data, any columns);
    // other days (before the export started, or not exported yet) from the Data API.
    const exp = ctx.ga4Export;
    const exportPart =
      exp && exp.first <= ctx.window.to && exp.last >= ctx.window.from
        ? { from: maxIso(exp.first, ctx.window.from), to: minIso(exp.last, ctx.window.to) }
        : null;
    const apiParts: { from: string; to: string }[] = [];
    if (!exportPart) apiParts.push(ctx.window);
    else {
      if (ctx.window.from < exportPart.from) apiParts.push({ from: ctx.window.from, to: addDaysIso(exportPart.from, -1) });
      if (exportPart.to < ctx.window.to) apiParts.push({ from: addDaysIso(exportPart.to, 1), to: ctx.window.to });
    }

    if (exportPart) {
      const rows = await exp!.query(exportPart, fields);
      apiCalls += 1;
      for (const values of rows) records.push(this.toRecord(values, fields, ctx, null, ctx.companyTimezone));
    }

    if (apiParts.length) {
      const problem = ga4SelectionProblem(ctx.options?.ga4Reports);
      if (problem) {
        // More columns than the Data API allows: those days exist only in the export.
        notes.push(`Days ${apiParts.map((p) => `${p.from} – ${p.to}`).join(", ")} were not loaded: they are not in the GA4 BigQuery export, and ${problem.replace(/ Switch.*$/, "")}`);
      } else {
        const f = this.cfg.fetch ?? fetch;
        const accessToken = await refreshAccessToken(this.cfg, ctx.credentials.refreshToken);
        apiCalls += 1;
        for (const part of apiParts) {
          const r = await this.fetchApi(f, accessToken, ctx, fields, part);
          apiCalls += r.apiCalls;
          records.push(...r.records);
          notes.push(...r.notes);
          if (!r.complete) complete = false;
        }
      }
    }
    return { records, apiCalls, complete, notes };
  }

  /** One stored row (every requested field by name) → a daily record for the dashboard. */
  private toRecord(values: Record<string, string>, fields: { dimensions: string[] }, ctx: FetchContext, currency: string | null, tz: string): ProviderDailyRecord {
    const num = (k: string) => {
      const n = Number(values[k]);
      return values[k] !== undefined && values[k] !== "" && Number.isFinite(n) ? n : null;
    };
    const campaignId = values.sessionCampaignId ?? "";
    const campaignName = values.sessionCampaignName ?? "";
    return {
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
      currency,
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
    };
  }

  private async fetchApi(
    f: FetchLike,
    accessToken: string,
    ctx: FetchContext,
    fields: { dimensions: string[]; metrics: string[] },
    window: { from: string; to: string },
  ): Promise<FetchResult> {
    let apiCalls = 0;
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
          dateRanges: [{ startDate: window.from, endDate: window.to }],
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
        const values: Record<string, string> = {};
        fields.dimensions.forEach((d, i) => (values[d] = row.dimensionValues[i]?.value ?? ""));
        fields.metrics.forEach((m, i) => (values[m] = row.metricValues[i]?.value ?? ""));
        records.push(this.toRecord(values, fields, ctx, body.metadata?.currencyCode ?? null, tz));
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

function maxIso(a: string, b: string): string {
  return a > b ? a : b;
}
function minIso(a: string, b: string): string {
  return a < b ? a : b;
}
function addDaysIso(d: string, n: number): string {
  const x = new Date(`${d}T00:00:00Z`);
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
}
