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
): Promise<{ refreshToken: string | null; scopes: string[] }> {
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
  const json = JSON.parse(body) as { refresh_token?: string; scope?: string };
  return { refreshToken: json.refresh_token ?? null, scopes: (json.scope ?? "").split(" ").filter(Boolean) };
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
