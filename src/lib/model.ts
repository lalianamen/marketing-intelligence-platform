// Canonical analytics model shared by ingestion, warehouse adapters, the KPI
// engine and the UI. Client-safe (types and pure helpers only).

/** Where a row came from: a connector, or a manual CSV upload. */
export type Origin = "csv" | "ga4" | "google_ads" | "google_search_console" | "microsoft_clarity" | "stripe" | "bing_webmaster";

/**
 * What a "conversion" means for a row. These are NOT interchangeable and are
 * never summed together into one cross-channel total.
 */
export type ConversionType = "ad_platform_conversion" | "ga4_key_event" | "csv_conversion";

export type DataStatus = "preliminary" | "final";

/** Grain: one row per (metric_date, origin, source, account_id, campaign_id). */
export interface NormalizedRow {
  row_key: string;
  metric_date: string; // YYYY-MM-DD, calendar day in source_timezone
  origin: Origin;
  source: string; // e.g. google_ads, ga4, meta_ads (CSV free-form slug)
  account_id: string;
  account_name: string | null;
  campaign_id: string;
  campaign_name: string | null;
  currency: string | null; // ISO 4217, required when spend/revenue present
  source_timezone: string;
  impressions: number | null;
  clicks: number | null;
  spend: number | null;
  sessions: number | null;
  conversions: number | null;
  conversion_type: ConversionType | null;
  leads: number | null;
  attributed_revenue: number | null;
  billed_revenue: number | null;
  data_status: DataStatus;
  is_simulated: boolean;
  sync_run_id: string;
  updated_at: string; // ISO timestamp
}

export const METRIC_FIELDS = [
  "impressions",
  "clicks",
  "spend",
  "sessions",
  "conversions",
  "leads",
  "attributed_revenue",
  "billed_revenue",
] as const;
export type MetricField = (typeof METRIC_FIELDS)[number];

export interface RawRecord {
  record_id: string;
  sync_run_id: string;
  origin: Origin;
  source: string;
  record_date: string;
  ingested_at: string;
  payload_json: string;
  is_simulated: boolean;
  schema_version: number;
}

/** Mart grain: one row per (metric_date, origin, source, currency, is_simulated). */
export interface MartRow {
  metric_date: string;
  origin: Origin;
  source: string;
  currency: string | null;
  is_simulated: boolean;
  impressions: number | null;
  clicks: number | null;
  spend: number | null;
  sessions: number | null;
  conversions: number | null;
  conversion_type: ConversionType | null;
  leads: number | null;
  attributed_revenue: number | null;
  billed_revenue: number | null;
  campaign_count: number;
  has_preliminary: boolean;
}

export interface CampaignRow {
  origin: Origin;
  source: string;
  account_id: string;
  account_name: string | null;
  campaign_id: string;
  campaign_name: string | null;
  currency: string | null;
  is_simulated: boolean;
  impressions: number | null;
  clicks: number | null;
  spend: number | null;
  sessions: number | null;
  conversions: number | null;
  conversion_type: ConversionType | null;
  leads: number | null;
  attributed_revenue: number | null;
  first_date: string;
  last_date: string;
}

export const ORIGIN_LABEL: Record<Origin, string> = {
  csv: "CSV import",
  ga4: "Google Analytics 4",
  google_ads: "Google Ads",
  google_search_console: "Google Search Console",
  microsoft_clarity: "Microsoft Clarity",
  stripe: "Stripe",
  bing_webmaster: "Bing Webmaster Tools",
};

export const CONVERSION_TYPE_LABEL: Record<ConversionType, string> = {
  ad_platform_conversion: "Ad-platform conversions",
  ga4_key_event: "GA4 key events",
  csv_conversion: "Conversions (as defined in your CSV)",
};
