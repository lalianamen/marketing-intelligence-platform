import type { ConversionType, Origin } from "../../lib/model";

// Common connector contract. Each provider adapter implements fetchDaily for a
// date window; the shared sync engine (src/server/sync/runSync.ts) handles
// checkpoints, late-arriving data, validation, raw/normalized/mart writes,
// retries and status. New providers (Meta Ads, Microsoft Ads, TikTok, Shopify,
// CRM…) implement this interface; nothing else changes.

export interface DailyMetrics {
  impressions: number | null;
  clicks: number | null;
  spend: number | null;
  sessions: number | null;
  conversions: number | null;
  conversion_type: ConversionType | null;
  leads: number | null;
  attributed_revenue: number | null;
  billed_revenue: number | null;
}

export interface ProviderDailyRecord {
  date: string; // YYYY-MM-DD in the provider account's reporting timezone
  account_id: string;
  account_name: string | null;
  campaign_id: string;
  campaign_name: string | null;
  currency: string | null;
  timezone: string;
  metrics: DailyMetrics;
  /** Source-faithful payload stored in the RAW layer. */
  raw: Record<string, unknown>;
  /** Distinguishes raw rows that share a campaign/day (e.g. split by extra breakdowns). */
  rawKey?: string;
  /**
   * "table": a row of the connector's table only (not counted on the dashboard);
   * "dashboard": the day's true total only (not shown as a table row).
   * Used when table rows do not add up to the total (Search Console hides rare queries).
   */
  role?: "table" | "dashboard";
}

export interface FetchContext {
  window: { from: string; to: string };
  externalAccountId: string;
  companyId: string;
  companyTimezone: string;
  /** Present only for live connections; decrypted server-side just for this call. */
  credentials?: { refreshToken: string };
  now: Date;
  signal?: AbortSignal;
  /** Per-connection options, e.g. the GA4 groups the user switched on. */
  options?: { ga4Reports?: string[]; columns?: string[] };
  /**
   * GA4 only: days already in GA4's own BigQuery export (ADR 0006) and how to read them.
   * Returns rows with the requested GA4 columns by name, values as strings.
   */
  ga4Export?: {
    first: string;
    last: string;
    query: (range: { from: string; to: string }, fields: { dimensions: string[]; metrics: string[] }) => Promise<Record<string, string>[]>;
  };
}


export interface FetchResult {
  records: ProviderDailyRecord[];
  apiCalls: number;
  /** false when pagination/row limits mean the window may be incomplete. */
  complete: boolean;
  notes: string[];
}

export interface Connector {
  readonly providerId: "ga4" | "google_ads" | "google_search_console" | "microsoft_clarity";
  readonly origin: Origin;
  readonly mode: "live" | "simulated";
  readonly requiredScopes: readonly string[];
  /** Days after which data is considered final (late-arrival window). */
  readonly finalizationDays: number;
  /** Days re-fetched on every incremental sync to pick up late-arriving data. */
  readonly lookbackDays: number;
  /** The source has no dates (only "the last 24 hours"): every load is exactly yesterday. */
  readonly singleDay?: boolean;
  fetchDaily(ctx: FetchContext): Promise<FetchResult>;
}

export type ConnectorErrorCode =
  | "auth_expired"
  | "permission_denied"
  | "quota_exceeded"
  | "rate_limited"
  | "timeout"
  | "unavailable"
  | "invalid_request"
  | "not_configured"
  | "incomplete_data";

const RETRYABLE = new Set<ConnectorErrorCode>(["quota_exceeded", "rate_limited", "timeout", "unavailable", "incomplete_data"]);

export class ConnectorError extends Error {
  readonly retryable: boolean;
  constructor(
    readonly code: ConnectorErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ConnectorError";
    this.retryable = RETRYABLE.has(code);
  }
}

export function connectorErrorFromHttp(status: number, body: string, provider: string): ConnectorError {
  const text = body.slice(0, 300);
  if (status === 401) return new ConnectorError("auth_expired", `${provider}: authorization expired or revoked`);
  if (status === 429 || /RESOURCE_EXHAUSTED|RESOURCE_TEMPORARILY_EXHAUSTED/.test(body))
    return new ConnectorError(status === 429 ? "rate_limited" : "quota_exceeded", `${provider}: quota or rate limit reached`);
  if (status === 403) return new ConnectorError("permission_denied", `${provider}: permission denied (${text})`);
  if (status >= 500) return new ConnectorError("unavailable", `${provider}: service unavailable (${status})`);
  return new ConnectorError("invalid_request", `${provider}: request rejected (${status}: ${text})`);
}
