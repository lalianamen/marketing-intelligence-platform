import { type FetchLike } from "./google";
import { columnCatalog } from "../../lib/columnCatalog";
import { CLARITY_DIMENSIONS } from "../../lib/clarityCatalog";
import { type Connector, ConnectorError, connectorErrorFromHttp, type FetchContext, type FetchResult, type ProviderDailyRecord } from "./types";

// Microsoft Clarity LIVE connector — Data Export API (project-live-insights).
// Auth: a project API token the user creates in Clarity (Settings → Data Export),
// stored encrypted like an OAuth refresh token. Limits (Microsoft): 10 requests
// per project per day, at most 3 breakdowns, 1,000 rows, last 1–3 days only and
// no dates in the answer. So one load = the last 24 hours, filed under the
// previous day (the schedule runs right after midnight). History cannot be loaded.
// Clarity's numbers never go into the dashboard totals (they would repeat GA4's
// sessions); they are shown in the connector's table.

const URL_BASE = "https://www.clarity.ms/export-data/api/v1/project-live-insights";

type InsightBlock = { metricName?: string; information?: Record<string, unknown>[] };

const SAFE = /[^A-Za-z0-9_]/g;

/** Calls the API once (one of the 10 daily requests). */
export async function fetchClarityInsights(f: FetchLike, token: string, dimensions: string[]): Promise<InsightBlock[]> {
  const url = new URL(URL_BASE);
  url.searchParams.set("numOfDays", "1");
  dimensions.slice(0, 3).forEach((d, i) => url.searchParams.set(`dimension${i + 1}`, CLARITY_DIMENSIONS[d]!));
  let res: Response;
  try {
    res = await f(url.toString(), { headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, signal: AbortSignal.timeout(30_000) });
  } catch (err) {
    throw new ConnectorError("timeout", `clarity: ${(err as Error).name}`);
  }
  const body = await res.text();
  if (res.status === 429) throw new ConnectorError("quota_exceeded", "clarity: the daily limit of 10 requests for this project is used up; it resets tomorrow");
  if (res.status === 401 || res.status === 403) throw new ConnectorError("auth_expired", "clarity: the API token is invalid, expired or was removed");
  if (!res.ok) throw connectorErrorFromHttp(res.status, body, "clarity");
  const json = body ? JSON.parse(body) : [];
  if (!Array.isArray(json)) throw new ConnectorError("invalid_request", "clarity: unexpected answer");
  return json as InsightBlock[];
}

/**
 * Turns Clarity's answer (one block per metric, rows keyed by the breakdowns) into one
 * row per breakdown combination: the breakdowns plus every number as "<metric>.<field>".
 */
export function clarityRows(blocks: InsightBlock[], dimensions: string[]): Record<string, unknown>[] {
  const apiNames = dimensions.map((d) => CLARITY_DIMENSIONS[d]!);
  const rows = new Map<string, Record<string, unknown>>();
  for (const b of blocks) {
    const metric = String(b.metricName ?? "metric").replace(SAFE, "").slice(0, 60) || "metric";
    for (const info of b.information ?? []) {
      const dims = apiNames.map((a) => String(info[a] ?? "(not set)"));
      const key = dims.join("\u001f");
      let row = rows.get(key);
      if (!row) {
        row = {};
        dimensions.forEach((d, i) => (row![d] = dims[i]));
        rows.set(key, row);
      }
      const values: Record<string, unknown> = (row[metric] as Record<string, unknown>) ?? {};
      for (const [k, v] of Object.entries(info)) {
        if (apiNames.includes(k)) continue;
        const field = k.replace(SAFE, "").slice(0, 60);
        if (field && (typeof v === "string" || typeof v === "number" || typeof v === "boolean" || v === null)) values[field] = v;
      }
      row[metric] = values;
    }
  }
  return [...rows.values()];
}

export class ClarityConnector implements Connector {
  readonly providerId = "microsoft_clarity" as const;
  readonly origin = "microsoft_clarity" as const;
  readonly mode = "live" as const;
  readonly requiredScopes = [] as const;
  readonly finalizationDays = 0;
  readonly lookbackDays = 0;
  /** Clarity has no dates: every load is exactly one day (yesterday). */
  readonly singleDay = true;

  constructor(private readonly cfg: { fetch?: FetchLike } = {}) {}

  async fetchDaily(ctx: FetchContext): Promise<FetchResult> {
    if (!ctx.credentials) throw new ConnectorError("auth_expired", "clarity: connection has no stored API token");
    const day = ctx.window.to;
    const dims = columnCatalog("microsoft_clarity")!.fields(ctx.options?.columns).dimensions.filter((d) => d !== "date");
    const blocks = await fetchClarityInsights(this.cfg.fetch ?? fetch, ctx.credentials.refreshToken, dims);
    const loadedAt = ctx.now.toISOString();
    const base = {
      date: day,
      account_id: ctx.externalAccountId,
      account_name: null,
      campaign_id: "clarity",
      campaign_name: "Microsoft Clarity",
      currency: null,
      timezone: "UTC",
      // Not added to dashboard totals (sessions would repeat GA4's).
      metrics: { impressions: null, clicks: null, spend: null, sessions: null, conversions: null, conversion_type: null, leads: null, attributed_revenue: null, billed_revenue: null },
    };
    const records: ProviderDailyRecord[] = [{ ...base, raw: {}, role: "dashboard" }];
    for (const row of clarityRows(blocks, dims)) {
      records.push({ ...base, raw: { date: day, ...row }, rawKey: dims.map((d) => String(row[d] ?? "")).join("\u001f"), role: "table" });
    }
    const notes = [`Clarity's last 24 hours before ${loadedAt.slice(0, 16).replace("T", " ")} UTC, filed under ${day}.`];
    if (records.length > 1000) notes.push("Clarity returns at most 1,000 rows; some combinations may be missing.");
    return { records, apiCalls: 1, complete: true, notes };
  }
}
