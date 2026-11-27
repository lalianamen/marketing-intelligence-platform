import { createHmac } from "node:crypto";
import { type FetchLike } from "./google";
import { columnCatalog } from "../../lib/columnCatalog";
import { META_BREAKDOWNS } from "../../lib/metaCatalog";
import { type Connector, ConnectorError, type FetchContext, type FetchResult, type ProviderDailyRecord } from "./types";

// Meta Ads LIVE connector — Marketing API Insights (Facebook + Instagram ads).
// Auth: "Connect with Facebook" (Facebook Login, permission ads_read). The stored
// secret is a long-lived user access token; Meta documents that apps with
// Marketing API access get long-lived tokens that do not expire by time, but a
// token can still be invalidated (password change, removed app) → error 190 →
// "Reconnect". Every call carries appsecret_proof.
// Data: GET /act_{id}/insights, level=campaign, time_increment=1, in the ad
// account's time zone and currency. Purchases, leads and purchase value come
// from Meta's "actions" / "action_values" (one action type each, no double counting).
// Meta: insights refresh every 15 minutes and can change for days after; the
// last 7 days are re-read on every load.

export const META_SCOPE = "ads_read";
const PAGE_LIMIT = 500;
const MAX_PAGES = 200;

export interface MetaAppConfig {
  appId: string;
  appSecret: string;
  apiVersion: string;
  redirectUri?: string;
  /** Facebook Login for Business configuration (optional; replaces scope when set). */
  configId?: string;
}

const graph = (cfg: MetaAppConfig) => {
  if (!/^v\d{1,3}\.\d$/.test(cfg.apiVersion)) throw new ConnectorError("not_configured", "meta: invalid API version");
  return `https://graph.facebook.com/${cfg.apiVersion}`;
};

export function metaDialogUrl(cfg: MetaAppConfig, state: string): string {
  const u = new URL(`https://www.facebook.com/${cfg.apiVersion}/dialog/oauth`);
  const p: Record<string, string> = { client_id: cfg.appId, redirect_uri: cfg.redirectUri ?? "", state, response_type: "code" };
  if (cfg.configId) p.config_id = cfg.configId;
  else p.scope = META_SCOPE;
  u.search = new URLSearchParams(p).toString();
  return u.toString();
}

/** Turns a Graph API error answer into a ConnectorError. */
export function metaError(status: number, body: string): ConnectorError {
  let e: { code?: number; error_subcode?: number; message?: string } = {};
  try {
    e = (JSON.parse(body) as { error?: typeof e }).error ?? {};
  } catch {
    /* not JSON */
  }
  const code = e.code ?? 0;
  const msg = String(e.message ?? "").slice(0, 200);
  if (code === 190 || code === 102) return new ConnectorError("auth_expired", "meta: the Facebook sign-in expired or was removed; reconnect with Facebook");
  if ([4, 17, 32, 613].includes(code) || (code >= 80000 && code <= 80014)) return new ConnectorError("rate_limited", `meta: rate limit reached (${code})`);
  if (code === 10 || code === 200 || code === 294 || (code >= 200 && code <= 299))
    return new ConnectorError("permission_denied", `meta: no permission to read this ad account (${msg})`);
  if (status >= 500 || code === 1 || code === 2) return new ConnectorError("unavailable", `meta: service unavailable (${status})`);
  return new ConnectorError("invalid_request", `meta: request rejected (${status}: ${code} ${msg})`);
}

async function getJson(f: FetchLike, url: string): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await f(url, { signal: AbortSignal.timeout(60_000) });
  } catch (err) {
    throw new ConnectorError("timeout", `meta: ${(err as Error).name}`);
  }
  const body = await res.text();
  if (!res.ok) throw metaError(res.status, body);
  try {
    return body ? (JSON.parse(body) as Record<string, unknown>) : {};
  } catch {
    throw new ConnectorError("invalid_request", `meta: unexpected answer (${res.status}, not JSON)`);
  }
}

function signed(cfg: MetaAppConfig, path: string, token: string, params: Record<string, string> = {}): string {
  const u = new URL(`${graph(cfg)}${path}`);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  u.searchParams.set("access_token", token);
  u.searchParams.set("appsecret_proof", createHmac("sha256", cfg.appSecret).update(token).digest("hex"));
  return u.toString();
}

/** Authorization code → long-lived user access token. */
export async function exchangeMetaCode(f: FetchLike, cfg: MetaAppConfig, code: string): Promise<string> {
  const short = new URL(`${graph(cfg)}/oauth/access_token`);
  short.search = new URLSearchParams({ client_id: cfg.appId, client_secret: cfg.appSecret, redirect_uri: cfg.redirectUri ?? "", code }).toString();
  const a = await getJson(f, short.toString());
  if (typeof a.access_token !== "string") throw new ConnectorError("invalid_request", "meta: token answer without an access token");
  const long = new URL(`${graph(cfg)}/oauth/access_token`);
  long.search = new URLSearchParams({ grant_type: "fb_exchange_token", client_id: cfg.appId, client_secret: cfg.appSecret, fb_exchange_token: a.access_token }).toString();
  const b = await getJson(f, long.toString());
  return typeof b.access_token === "string" ? b.access_token : a.access_token;
}

export interface MetaAdAccount {
  id: string;
  name: string;
  group: string | null;
}

/** Ad accounts the signed-in person can read (closed and disabled ones are skipped). */
export async function listMetaAdAccounts(f: FetchLike, cfg: MetaAppConfig, token: string): Promise<MetaAdAccount[]> {
  const out: MetaAdAccount[] = [];
  let url: string | null = signed(cfg, "/me/adaccounts", token, { fields: "id,name,account_id,currency,account_status,business{name}", limit: "100" });
  for (let page = 0; url && page < 20; page++) {
    const json = await getJson(f, url);
    for (const a of (json.data as Record<string, unknown>[] | undefined) ?? []) {
      const id = String(a.id ?? "");
      if (!/^act_\d{1,30}$/.test(id) || [2, 101, 202].includes(Number(a.account_status))) continue;
      const name = `${String(a.name ?? id).slice(0, 150)}${a.currency ? ` (${String(a.currency)})` : ""}`;
      const business = (a.business as { name?: string } | undefined)?.name;
      out.push({ id, name, group: business ? String(business).slice(0, 40) : null });
    }
    url = ((json.paging as { next?: string } | undefined)?.next as string | undefined) ?? null;
  }
  return out;
}

type Action = { action_type?: string; value?: string | number };

/** One value per meaning, in Meta's order of preference (the types overlap, so never add them up). */
export function pickAction(list: unknown, types: string[]): number {
  const arr = Array.isArray(list) ? (list as Action[]) : [];
  for (const t of types) {
    const a = arr.find((x) => x.action_type === t);
    if (a) return Number(a.value) || 0;
  }
  return 0;
}
const PURCHASE = ["omni_purchase", "purchase", "offsite_conversion.fb_pixel_purchase", "onsite_web_purchase"];
const LEAD = ["lead", "onsite_conversion.lead_grouped", "offsite_conversion.fb_pixel_lead"];

const n = (v: unknown) => (v === undefined || v === null || v === "" ? 0 : Number(v) || 0);

export class MetaAdsConnector implements Connector {
  readonly providerId = "meta_ads" as const;
  readonly origin = "meta_ads" as const;
  readonly mode = "live" as const;
  readonly requiredScopes = [META_SCOPE] as const;
  readonly finalizationDays = 7;
  readonly lookbackDays = 7;

  constructor(private readonly cfg: MetaAppConfig & { fetch?: FetchLike }) {}

  async fetchDaily(ctx: FetchContext): Promise<FetchResult> {
    if (!ctx.credentials) throw new ConnectorError("auth_expired", "meta: connection has no stored sign-in");
    const account = ctx.externalAccountId;
    if (!/^act_\d{1,30}$/.test(account)) throw new ConnectorError("invalid_request", "meta: unexpected ad account id");
    const f = this.cfg.fetch ?? fetch;
    const token = ctx.credentials.refreshToken;
    let apiCalls = 0;

    const info = await getJson(f, signed(this.cfg, `/${account}`, token, { fields: "name,currency,timezone_name" }));
    apiCalls++;
    const currency = typeof info.currency === "string" ? info.currency.toUpperCase() : null;
    const timezone = typeof info.timezone_name === "string" ? info.timezone_name : ctx.companyTimezone;
    const accountName = typeof info.name === "string" ? info.name : null;

    const fields = columnCatalog("meta_ads")!.fields(ctx.options?.columns);
    const breakdown = fields.dimensions.find((d) => d in META_BREAKDOWNS);

    const insights = async (breakdowns: string | null) => {
      const rows: Record<string, unknown>[] = [];
      const params: Record<string, string> = {
        level: "campaign",
        time_increment: "1",
        time_range: JSON.stringify({ since: ctx.window.from, until: ctx.window.to }),
        fields: "campaign_id,campaign_name,spend,impressions,clicks,actions,action_values",
        use_unified_attribution_setting: "true",
        limit: String(PAGE_LIMIT),
      };
      if (breakdowns) params.breakdowns = breakdowns;
      let url: string | null = signed(this.cfg, `/${account}/insights`, token, params);
      for (let page = 0; url && page < MAX_PAGES; page++) {
        const json = await getJson(f, url);
        apiCalls++;
        rows.push(...((json.data as Record<string, unknown>[] | undefined) ?? []));
        url = (json.paging as { next?: string } | undefined)?.next ?? null;
      }
      return { rows, complete: url === null };
    };

    const values = (r: Record<string, unknown>) => ({
      date: String(r.date_start ?? ""),
      campaign_id: String(r.campaign_id ?? ""),
      campaign_name: String(r.campaign_name ?? ""),
      spend: n(r.spend),
      impressions: n(r.impressions),
      clicks: n(r.clicks),
      purchases: pickAction(r.actions, PURCHASE),
      purchase_value: pickAction(r.action_values, PURCHASE),
      leads: pickAction(r.actions, LEAD),
    });
    const record = (v: Record<string, string | number>, role: ProviderDailyRecord["role"], dashboard: boolean): ProviderDailyRecord => ({
      date: String(v.date),
      account_id: account,
      account_name: accountName,
      campaign_id: String(v.campaign_id),
      campaign_name: String(v.campaign_name) || null,
      currency,
      timezone,
      metrics: dashboard
        ? {
            impressions: Number(v.impressions),
            clicks: Number(v.clicks),
            spend: Number(v.spend),
            sessions: null,
            conversions: Number(v.purchases),
            conversion_type: "ad_platform_conversion",
            leads: Number(v.leads),
            attributed_revenue: Number(v.purchase_value),
            billed_revenue: null,
          }
        : { impressions: null, clicks: null, spend: null, sessions: null, conversions: null, conversion_type: null, leads: null, attributed_revenue: null, billed_revenue: null },
      raw: v,
      rawKey: fields.dimensions.map((d) => String(v[d] ?? "")).join("\u001f"),
      role,
    });

    const records: ProviderDailyRecord[] = [];
    const totals = await insights(null);
    for (const r of totals.rows) {
      const v = values(r);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(v.date) || !v.campaign_id) continue;
      records.push(record(v, breakdown ? "dashboard" : undefined, true));
    }
    const notes: string[] = [];
    let complete = totals.complete;
    if (breakdown) {
      const detail = await insights(META_BREAKDOWNS[breakdown]!);
      for (const r of detail.rows) {
        const v = { ...values(r), [breakdown]: String(r[META_BREAKDOWNS[breakdown]!] ?? "") };
        if (!/^\d{4}-\d{2}-\d{2}$/.test(v.date) || !v.campaign_id) continue;
        records.push(record(v, "table", false));
      }
      complete = complete && detail.complete;
    }
    if (!complete) notes.push(`Meta returned more than ${MAX_PAGES * PAGE_LIMIT} rows; load a shorter period.`);
    return { records, apiCalls, complete, notes };
  }
}
