import { type FetchLike, postJson, refreshAccessToken } from "./google";
import { columnCatalog } from "../../lib/columnCatalog";
import { type Connector, ConnectorError, type FetchContext, type FetchResult, type ProviderDailyRecord } from "./types";

// Google Search Console LIVE connector — Search Analytics API (searchAnalytics.query).
// Same model as GA4: one table with the chosen columns (query, page, country,
// device), one request per load. Search Console hides rare queries, so table rows
// add up to less than the day: the dashboard uses a separate per-day total.
// Dates are Pacific Time, as Search Console reports them. Data arrives with a
// delay of about 2–3 days; the last days are preliminary and re-read.

export const GSC_SCOPE = "https://www.googleapis.com/auth/webmasters.readonly";
const PAGE_SIZE = 25_000;
const MAX_PAGES = 40;

export function isSearchConsoleSite(id: string): boolean {
  return id.length <= 300 && /^(sc-domain:[a-z0-9.-]+|https?:\/\/[^\s]+)$/i.test(id);
}

interface GscResponse {
  rows?: { keys?: string[]; clicks?: number; impressions?: number; ctr?: number; position?: number }[];
}

export class SearchConsoleConnector implements Connector {
  readonly providerId = "google_search_console" as const;
  readonly origin = "google_search_console" as const;
  readonly mode = "live" as const;
  readonly requiredScopes = [GSC_SCOPE] as const;
  readonly finalizationDays = 3;
  readonly lookbackDays = 4;

  constructor(private readonly cfg: { clientId: string; clientSecret: string; fetch?: FetchLike }) {}

  async fetchDaily(ctx: FetchContext): Promise<FetchResult> {
    if (!ctx.credentials) throw new ConnectorError("auth_expired", "search console: connection has no stored authorization");
    if (!isSearchConsoleSite(ctx.externalAccountId)) throw new ConnectorError("invalid_request", "search console: unexpected site id");
    const f = this.cfg.fetch ?? fetch;
    const token = await refreshAccessToken(this.cfg, ctx.credentials.refreshToken);
    const cat = columnCatalog("google_search_console")!;
    const fields = cat.fields(ctx.options?.columns);
    const breakdowns = fields.dimensions.filter((d) => d !== "date");
    const url = `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(ctx.externalAccountId)}/searchAnalytics/query`;
    const tz = "America/Los_Angeles";
    let apiCalls = 1;
    const notes: string[] = [];
    const records: ProviderDailyRecord[] = [];

    const query = async (dimensions: string[]) => {
      const rows: NonNullable<GscResponse["rows"]> = [];
      for (let page = 0; page < MAX_PAGES; page++) {
        const { json, calls } = await postJson(
          f,
          url,
          { authorization: `Bearer ${token}` },
          { startDate: ctx.window.from, endDate: ctx.window.to, dimensions, type: "web", dataState: "all", rowLimit: PAGE_SIZE, startRow: page * PAGE_SIZE },
          "search console",
        );
        apiCalls += calls;
        const got = (json as GscResponse).rows ?? [];
        rows.push(...got);
        if (got.length < PAGE_SIZE) return { rows, complete: true };
      }
      return { rows, complete: false };
    };
    const record = (values: Record<string, string>, role: ProviderDailyRecord["role"], clicks: number | null, impressions: number | null): ProviderDailyRecord => ({
      date: values.date!,
      account_id: ctx.externalAccountId,
      account_name: null,
      campaign_id: "google_search",
      campaign_name: "Google Search (organic)",
      currency: null,
      timezone: tz,
      metrics: { impressions, clicks, spend: null, sessions: null, conversions: null, conversion_type: null, leads: null, attributed_revenue: null, billed_revenue: null },
      raw: values,
      rawKey: fields.dimensions.map((d) => values[d] ?? "").join("\u001f"),
      role,
    });
    const values = (dims: string[], r: NonNullable<GscResponse["rows"]>[number]) => {
      const v: Record<string, string> = {};
      dims.forEach((d, i) => (v[d] = r.keys?.[i] ?? ""));
      for (const m of fields.metrics) v[m] = r[m as "clicks"] === undefined ? "" : String(r[m as "clicks"]);
      return v;
    };

    // Per-day totals: the dashboard numbers (and the table rows when no breakdown is chosen).
    const totals = await query(["date"]);
    for (const r of totals.rows) {
      records.push(record(values(["date"], r), breakdowns.length ? "dashboard" : undefined, r.clicks ?? null, r.impressions ?? null));
    }
    if (breakdowns.length) {
      const detail = await query(fields.dimensions);
      for (const r of detail.rows) records.push(record(values(fields.dimensions, r), "table", null, null));
      if (!detail.complete) {
        notes.push(`Search Console returned more than ${MAX_PAGES * PAGE_SIZE} rows; the table may be incomplete for this period (dashboard totals are complete).`);
      }
      if (breakdowns.includes("query")) notes.push("Search Console hides rare search queries; table rows add up to less than the day's total.");
    }
    return { records, apiCalls, complete: totals.complete, notes };
  }
}

/** Search Console sites the signed-in user can read (verified owners and users). */
export async function listSearchConsoleSites(accessToken: string, fetchImpl?: FetchLike): Promise<{ id: string; name: string; group: string | null }[]> {
  const f = fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await f("https://www.googleapis.com/webmasters/v3/sites", { headers: { authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(20_000) });
  } catch (err) {
    throw new ConnectorError("timeout", `search console: ${(err as Error).name}`);
  }
  const body = await res.text();
  if (!res.ok) {
    if (/SERVICE_DISABLED|has not been used in project|is disabled/.test(body)) {
      const project = /projects?[ /=]+(\d{6,})/.exec(body)?.[1];
      throw new ConnectorError("not_configured", `search console: the API is not enabled in the app's Google Cloud project${project ? ` (project number ${project})` : ""}`);
    }
    const { connectorErrorFromHttp } = await import("./types");
    throw connectorErrorFromHttp(res.status, body, "search console");
  }
  const json = (body ? JSON.parse(body) : {}) as { siteEntry?: { siteUrl?: string; permissionLevel?: string }[] };
  return (json.siteEntry ?? [])
    .filter((s) => s.siteUrl && isSearchConsoleSite(s.siteUrl) && s.permissionLevel !== "siteUnverifiedUser")
    .map((s) => ({
      id: s.siteUrl!,
      name: s.siteUrl!.startsWith("sc-domain:") ? `${s.siteUrl!.slice(10)} (whole domain)` : s.siteUrl!,
      group: null,
    }));
}
