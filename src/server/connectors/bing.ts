import { type FetchLike } from "./google";
import { columnCatalog } from "../../lib/columnCatalog";
import { type Connector, ConnectorError, connectorErrorFromHttp, type FetchContext, type FetchResult, type ProviderDailyRecord } from "./types";

// Bing Webmaster Tools LIVE connector — Bing Webmaster API (JSON).
// Auth, two ways (both cover all of the Bing user's verified sites; a connection
// is for one site, external account id = the site URL as Bing lists it):
// - "Sign in with Bing" (OAuth 2.0, scope webmaster.read): the stored secret is
//   "oauth:" + the refresh token; each load gets a short-lived access token.
// - The user's API key (Bing Webmaster → Settings → API Access): fallback when
//   the platform's Bing OAuth client is not configured.
// The stats methods take no dates: each returns everything Bing keeps, and the
// connector keeps the days of the requested window. Daily totals come from
// GetRankAndTrafficStats (dashboard); top queries / pages from GetQueryStats /
// GetPageStats (table only — Bing returns only the top ones, weekly).
// Dates come as "/Date(1316156400000-0700)/": the day is read in Bing's own offset.

const API_KEY_BASE = "https://ssl.bing.com/webmaster/api.svc/json";
// Microsoft's OAuth page calls the API on www.bing.com with a bearer token.
const API_OAUTH_BASE = "https://www.bing.com/webmaster/api.svc/json";
export const BING_AUTH_URL = "https://www.bing.com/webmasters/oauth/authorize";
const BING_TOKEN_URL = "https://www.bing.com/webmasters/oauth/token";
export const BING_SCOPE = "webmaster.read";
/** Marks a stored secret as an OAuth refresh token (API keys are letters and digits only). */
export const BING_OAUTH_PREFIX = "oauth:";

export interface BingOAuthClient {
  clientId: string;
  clientSecret: string;
  redirectUri?: string;
}

/** How a request is authorized: an API key, or an OAuth access token. */
export type BingAuth = { key: string } | { accessToken: string };

async function tokenRequest(f: FetchLike, params: Record<string, string>): Promise<{ access_token?: string; refresh_token?: string }> {
  let res: Response;
  try {
    res = await f(BING_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(params).toString(),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    throw new ConnectorError("timeout", `bing: ${(err as Error).name}`);
  }
  const body = await res.text();
  let json: { access_token?: string; refresh_token?: string; error?: string } = {};
  try {
    json = body ? JSON.parse(body) : {};
  } catch {
    /* not JSON */
  }
  if (!res.ok) {
    if (json.error === "invalid_grant" || res.status === 401) throw new ConnectorError("auth_expired", "bing: the sign-in was revoked or expired; reconnect with Bing");
    throw new ConnectorError(res.status >= 500 ? "unavailable" : "invalid_request", `bing: token request rejected (${res.status}: ${json.error ?? ""})`);
  }
  return json;
}

/** Authorization code → tokens (after the user allowed access on Bing's screen). */
export async function exchangeBingCode(f: FetchLike, client: BingOAuthClient, code: string): Promise<{ refreshToken: string | null; accessToken: string | null }> {
  const json = await tokenRequest(f, {
    client_id: client.clientId,
    client_secret: client.clientSecret,
    code,
    grant_type: "authorization_code",
    redirect_uri: client.redirectUri ?? "",
  });
  return { refreshToken: json.refresh_token ?? null, accessToken: json.access_token ?? null };
}

export async function refreshBingToken(f: FetchLike, client: BingOAuthClient, refreshToken: string): Promise<string> {
  const json = await tokenRequest(f, { client_id: client.clientId, client_secret: client.clientSecret, grant_type: "refresh_token", refresh_token: refreshToken });
  if (!json.access_token) throw new ConnectorError("invalid_request", "bing: token answer without an access token");
  return json.access_token;
}

/** "/Date(1316156400000-0700)/" → "2011-09-16" (the day in the offset Bing gives). */
export function bingDate(value: unknown): string | null {
  const m = /^\/Date\((-?\d+)([+-])?(\d{2})?(\d{2})?\)\/$/.exec(String(value ?? ""));
  if (!m) return null;
  let ms = Number(m[1]);
  if (m[2] && m[3] && m[4]) ms += (m[2] === "-" ? -1 : 1) * (Number(m[3]) * 60 + Number(m[4])) * 60_000;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

export function bingKeyProblem(key: string): string | null {
  if (!/^[A-Za-z0-9]{16,64}$/.test(key)) return "This does not look like a Bing Webmaster API key. Copy it again from Bing Webmaster → Settings → API Access.";
  return null;
}

export function isBingSite(id: string): boolean {
  return id.length <= 300 && /^https?:\/\/[^\s]+$/i.test(id);
}

/** Same site, ignoring case, scheme-less input and a trailing slash. */
export function sameBingSite(a: string, b: string): boolean {
  const n = (s: string) => s.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/+$/, "");
  return n(a) === n(b);
}

async function call(f: FetchLike, auth: BingAuth, method: string, params: Record<string, string> = {}): Promise<Record<string, unknown>[]> {
  const url = new URL(`${"key" in auth ? API_KEY_BASE : API_OAUTH_BASE}/${method}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const headers: Record<string, string> = { "content-type": "application/json; charset=utf-8" };
  if ("key" in auth) url.searchParams.set("apikey", auth.key);
  else headers.authorization = `Bearer ${auth.accessToken}`;
  let res: Response;
  try {
    res = await f(url.toString(), { headers, signal: AbortSignal.timeout(30_000) });
  } catch (err) {
    throw new ConnectorError("timeout", `bing: ${(err as Error).name}`);
  }
  const body = await res.text();
  if (!res.ok) {
    // Bing answers a wrong key with 400 {"ErrorCode":3,"Message":"ERROR!!! InvalidApiKey"},
    // a wrong or expired access token with 400 {"ErrorCode":18,"Message":"ERROR!!! InvalidToken"}.
    let message = "";
    try {
      message = String((JSON.parse(body) as { Message?: unknown }).Message ?? "");
    } catch {
      /* not JSON */
    }
    if (res.status === 401 || /InvalidApiKey|InvalidToken/i.test(message)) throw new ConnectorError("auth_expired", "bing: the sign-in or API key is no longer valid");
    if (res.status === 403 || /NotAuthorized|NotVerified|AccessDenied/i.test(message))
      throw new ConnectorError("permission_denied", `bing: this key may not read the site (${message.replace(/^ERROR!+\s*/, "").slice(0, 120)})`);
    throw connectorErrorFromHttp(res.status, body, "bing");
  }
  let json: unknown;
  try {
    json = body ? JSON.parse(body) : {};
  } catch {
    throw new ConnectorError("invalid_request", `bing: unexpected answer (${res.status}, not JSON)`);
  }
  const d = (json as { d?: unknown }).d;
  if (d === null || d === undefined) return [];
  if (!Array.isArray(d)) throw new ConnectorError("invalid_request", `bing: unexpected answer (${body.slice(0, 80)})`);
  return d as Record<string, unknown>[];
}

/** Verified sites the key's Bing user can read. */
export async function listBingSites(f: FetchLike, auth: BingAuth): Promise<string[]> {
  const sites = await call(f, auth, "GetUserSites");
  return sites.filter((s) => s.IsVerified !== false && typeof s.Url === "string" && isBingSite(s.Url)).map((s) => String(s.Url));
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v !== "" && Number.isFinite(Number(v)) ? Number(v) : null);

export class BingWebmasterConnector implements Connector {
  readonly providerId = "bing_webmaster" as const;
  readonly origin = "bing_webmaster" as const;
  readonly mode = "live" as const;
  readonly requiredScopes = [] as const;
  readonly finalizationDays = 3;
  /** Query and page rows are refreshed weekly: re-read two weeks on every load. */
  readonly lookbackDays = 14;

  constructor(private readonly cfg: { fetch?: FetchLike; oauth?: BingOAuthClient } = {}) {}

  async fetchDaily(ctx: FetchContext): Promise<FetchResult> {
    if (!ctx.credentials) throw new ConnectorError("auth_expired", "bing: connection has no stored API key");
    if (!isBingSite(ctx.externalAccountId)) throw new ConnectorError("invalid_request", "bing: unexpected site id");
    const f = this.cfg.fetch ?? fetch;
    const secret = ctx.credentials.refreshToken;
    let key: BingAuth;
    if (secret.startsWith(BING_OAUTH_PREFIX)) {
      if (!this.cfg.oauth) throw new ConnectorError("not_configured", "bing: sign-in with Bing is not configured on this server");
      key = { accessToken: await refreshBingToken(f, this.cfg.oauth, secret.slice(BING_OAUTH_PREFIX.length)) };
    } else {
      key = { key: secret };
    }
    const site = ctx.externalAccountId;
    const fields = columnCatalog("bing_webmaster")!.fields(ctx.options?.columns);
    const breakdown = fields.dimensions.find((d) => d === "query" || d === "page");
    const inWindow = (d: string | null): d is string => d !== null && d >= ctx.window.from && d <= ctx.window.to;
    const records: ProviderDailyRecord[] = [];
    const notes: string[] = [];
    let apiCalls = "accessToken" in key ? 1 : 0;

    const record = (values: Record<string, string | number | null>, role: ProviderDailyRecord["role"], clicks: number | null, impressions: number | null): ProviderDailyRecord => ({
      date: String(values.date),
      account_id: site,
      account_name: null,
      campaign_id: "bing_search",
      campaign_name: "Bing Search (organic)",
      currency: null,
      timezone: "America/Los_Angeles",
      metrics: { impressions, clicks, spend: null, sessions: null, conversions: null, conversion_type: null, leads: null, attributed_revenue: null, billed_revenue: null },
      raw: values,
      rawKey: fields.dimensions.map((d) => String(values[d] ?? "")).join("\u001f"),
      role,
    });

    // Per-day totals: the dashboard numbers (and the table rows when no breakdown is chosen).
    const totals = new Map<string, { clicks: number; impressions: number }>();
    for (const r of await call(f, key, "GetRankAndTrafficStats", { siteUrl: site })) {
      const date = bingDate(r.Date);
      if (!inWindow(date)) continue;
      const t = totals.get(date) ?? { clicks: 0, impressions: 0 };
      t.clicks += num(r.Clicks) ?? 0;
      t.impressions += num(r.Impressions) ?? 0;
      totals.set(date, t);
    }
    apiCalls++;
    for (const [date, t] of [...totals].sort(([a], [b]) => a.localeCompare(b))) {
      const values: Record<string, string | number | null> = { date, clicks: t.clicks, impressions: t.impressions, avg_click_position: null, avg_impression_position: null };
      if (breakdown) values[breakdown] = "";
      records.push(record(values, breakdown ? "dashboard" : undefined, t.clicks, t.impressions));
    }

    if (breakdown) {
      const rows = new Map<string, Record<string, string | number | null>>();
      for (const r of await call(f, key, breakdown === "query" ? "GetQueryStats" : "GetPageStats", { siteUrl: site })) {
        const date = bingDate(r.Date);
        if (!inWindow(date)) continue;
        const label = String(r.Query ?? "").slice(0, 500);
        const k = `${date}\u001f${label}`;
        const prev = rows.get(k);
        if (prev) {
          prev.clicks = Number(prev.clicks) + (num(r.Clicks) ?? 0);
          prev.impressions = Number(prev.impressions) + (num(r.Impressions) ?? 0);
          continue;
        }
        rows.set(k, {
          date,
          [breakdown]: label,
          clicks: num(r.Clicks) ?? 0,
          impressions: num(r.Impressions) ?? 0,
          avg_click_position: num(r.AvgClickPosition),
          avg_impression_position: num(r.AvgImpressionPosition),
        });
      }
      apiCalls++;
      for (const v of rows.values()) records.push(record(v, "table", null, null));
      notes.push(`Bing returns only top ${breakdown === "query" ? "queries" : "pages"} and refreshes them weekly; table rows add up to less than the day's total.`);
    }
    return { records, apiCalls, complete: true, notes };
  }
}
