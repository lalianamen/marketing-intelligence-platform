import { ConnectorError, connectorErrorFromHttp } from "./types";

// Shared Google OAuth + HTTP helpers (server only). Uses the official REST
// endpoints. Tokens are never logged; errors are summarized.

export const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

export const GA4_SCOPE = "https://www.googleapis.com/auth/analytics.readonly";
export const GOOGLE_ADS_SCOPE = "https://www.googleapis.com/auth/adwords";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface GoogleClientConfig {
  clientId: string;
  clientSecret: string;
  fetch?: FetchLike;
}

export async function refreshAccessToken(cfg: GoogleClientConfig, refreshToken: string): Promise<string> {
  const f = cfg.fetch ?? fetch;
  let res: Response;
  try {
    res = await f(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: cfg.clientId,
        client_secret: cfg.clientSecret,
        refresh_token: refreshToken,
        grant_type: "refresh_token",
      }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    throw new ConnectorError("timeout", `google oauth: ${(err as Error).name}`);
  }
  const body = await res.text();
  if (!res.ok) {
    // invalid_grant = refresh token expired/revoked (e.g. 7-day expiry for apps in "Testing").
    if (/invalid_grant/.test(body)) throw new ConnectorError("auth_expired", "google oauth: refresh token expired or revoked");
    throw connectorErrorFromHttp(res.status, body, "google oauth");
  }
  const json = JSON.parse(body) as { access_token?: string };
  if (!json.access_token) throw new ConnectorError("auth_expired", "google oauth: no access token returned");
  return json.access_token;
}

export async function exchangeCode(
  cfg: GoogleClientConfig & { redirectUri: string },
  code: string,
  codeVerifier: string,
): Promise<{ refreshToken: string | null; accessToken: string | null; scopes: string[] }> {
  const f = cfg.fetch ?? fetch;
  const res = await f(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      code,
      code_verifier: codeVerifier,
      grant_type: "authorization_code",
      redirect_uri: cfg.redirectUri,
    }),
    signal: AbortSignal.timeout(20_000),
  });
  const body = await res.text();
  if (!res.ok) throw connectorErrorFromHttp(res.status, body, "google oauth");
  const json = JSON.parse(body) as { refresh_token?: string; access_token?: string; scope?: string };
  return { refreshToken: json.refresh_token ?? null, accessToken: json.access_token ?? null, scopes: (json.scope ?? "").split(" ").filter(Boolean) };
}

/** POST JSON with bounded retries for 429/5xx (exponential backoff). */
export async function postJson(
  f: FetchLike,
  url: string,
  headers: Record<string, string>,
  payload: unknown,
  provider: string,
  opts: { attempts?: number; baseDelayMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<{ json: unknown; calls: number }> {
  const attempts = opts.attempts ?? 3;
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  let calls = 0;
  let last: ConnectorError | null = null;
  for (let i = 0; i < attempts; i++) {
    calls++;
    let res: Response;
    try {
      res = await f(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(60_000),
      });
    } catch (err) {
      last = new ConnectorError("timeout", `${provider}: request failed (${(err as Error).name})`);
      await sleep((opts.baseDelayMs ?? 500) * 2 ** i);
      continue;
    }
    const body = await res.text();
    if (res.ok) return { json: body ? JSON.parse(body) : {}, calls };
    last = connectorErrorFromHttp(res.status, body, provider);
    if (!last.retryable || last.code === "quota_exceeded") throw last; // daily quota: retry later, not now
    await sleep((opts.baseDelayMs ?? 500) * 2 ** i);
  }
  throw last ?? new ConnectorError("unavailable", `${provider}: failed`);
}

// ---------------------------------------------------------------------------
// Account discovery after consent: which GA4 properties / Google Ads accounts
// the signed-in Google user can read, so the user picks instead of typing IDs.
// ---------------------------------------------------------------------------

export interface DiscoveredAccount {
  /** GA4 property number or 10-digit Google Ads customer id. */
  id: string;
  name: string;
  /** Parent account name (GA4 account) when known. */
  group: string | null;
}

async function getJson(f: FetchLike, url: string, headers: Record<string, string>, provider: string): Promise<unknown> {
  let res: Response;
  try {
    res = await f(url, { headers, signal: AbortSignal.timeout(20_000) });
  } catch (err) {
    throw new ConnectorError("timeout", `${provider}: ${(err as Error).name}`);
  }
  const body = await res.text();
  if (!res.ok) {
    if (/SERVICE_DISABLED|has not been used in project|is disabled/.test(body)) {
      throw new ConnectorError("not_configured", `${provider}: the API is not enabled in the app's Google Cloud project`);
    }
    throw connectorErrorFromHttp(res.status, body, provider);
  }
  return body ? JSON.parse(body) : {};
}

/** GA4 properties visible to the user (Google Analytics Admin API, accountSummaries). */
export async function listGa4Properties(accessToken: string, fetchImpl?: FetchLike): Promise<DiscoveredAccount[]> {
  const f = fetchImpl ?? fetch;
  const out: DiscoveredAccount[] = [];
  let pageToken = "";
  for (let page = 0; page < 10; page++) {
    const url = new URL("https://analyticsadmin.googleapis.com/v1beta/accountSummaries");
    url.searchParams.set("pageSize", "200");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const json = (await getJson(f, url.toString(), { authorization: `Bearer ${accessToken}` }, "ga4 admin")) as {
      accountSummaries?: { displayName?: string; propertySummaries?: { property?: string; displayName?: string }[] }[];
      nextPageToken?: string;
    };
    for (const a of json.accountSummaries ?? []) {
      for (const p of a.propertySummaries ?? []) {
        const id = /^properties\/(\d{1,20})$/.exec(p.property ?? "")?.[1];
        if (id) out.push({ id, name: (p.displayName ?? `Property ${id}`).slice(0, 150), group: a.displayName?.slice(0, 150) ?? null });
      }
    }
    pageToken = json.nextPageToken ?? "";
    if (!pageToken) break;
  }
  return out;
}

/** Google Ads customer accounts the user can access (customers:listAccessibleCustomers), with names when readable. */
export async function listAdsCustomers(
  accessToken: string,
  cfg: { apiVersion: string; developerToken?: string; loginCustomerId?: string; fetch?: FetchLike },
): Promise<DiscoveredAccount[]> {
  if (!/^v\d{1,3}$/.test(cfg.apiVersion)) throw new ConnectorError("not_configured", "google_ads: invalid API version");
  const f = cfg.fetch ?? fetch;
  const headers: Record<string, string> = { authorization: `Bearer ${accessToken}` };
  if (cfg.developerToken) headers["developer-token"] = cfg.developerToken;
  const json = (await getJson(f, `https://googleads.googleapis.com/${cfg.apiVersion}/customers:listAccessibleCustomers`, headers, "google_ads")) as {
    resourceNames?: string[];
  };
  const ids = (json.resourceNames ?? []).map((r) => /^customers\/(\d{10})$/.exec(r)?.[1]).filter((x): x is string => Boolean(x));
  const out: DiscoveredAccount[] = [];
  for (const id of ids.slice(0, 50)) {
    let name = `Google Ads ${id.replace(/(\d{3})(\d{3})(\d{4})/, "$1-$2-$3")}`;
    try {
      const r = (await postJson(
        f,
        `https://googleads.googleapis.com/${cfg.apiVersion}/customers/${id}/googleAds:search`,
        { ...headers, "login-customer-id": id },
        { query: "SELECT customer.descriptive_name, customer.manager FROM customer LIMIT 1" },
        "google_ads",
      )) as { json: { results?: { customer?: { descriptiveName?: string; manager?: boolean } }[] } };
      const c = r.json.results?.[0]?.customer;
      if (c?.manager) continue; // manager (MCC) accounts have no campaigns of their own
      if (c?.descriptiveName) name = c.descriptiveName.slice(0, 150);
    } catch {
      // Name is optional; the account stays selectable by its id.
    }
    out.push({ id, name, group: null });
  }
  return out;
}
