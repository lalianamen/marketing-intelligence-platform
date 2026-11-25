// SQL over GA4's own BigQuery export (events_YYYYMMDD tables, ADR 0006).
// Events are first grouped into visits (user_pseudo_id + ga_session_id), then
// visits are added up by the chosen columns — any number of them, so the GA4
// Data API limit of 9 breakdowns does not apply. Column names are the same
// GA4 API names as in the Data API table, so the platform's table looks the same.
//
// Definitions (close to, not identical with, GA4 reports, which use estimates
// and hide small numbers):
//   sessions                visits with a ga_session_id
//   source / medium / ...   GA4's session attribution (session_traffic_source_last_click.cross_channel_campaign)
//   landingPage             path + query of the visit's first page_view
//   engagedSessions         visits GA4 marked session_engaged = 1
//   averageSessionDuration  seconds from first to last event of the visit, averaged
//   keyEvents               events whose name is a key event of the property
//   totalRevenue / purchaseRevenue  ecommerce.purchase_revenue; transactions = distinct transaction ids

/** Per-visit columns (visit CTE) for each breakdown, by GA4 API name. */
export const EXPORT_DIMENSIONS: Record<string, string> = {
  date: "FORMAT_DATE('%Y%m%d', s.visit_date)",
  sessionCampaignId: "s.c.campaign_id",
  sessionCampaignName: "s.c.campaign_name",
  sessionSource: "s.c.source",
  sessionMedium: "s.c.medium",
  sessionDefaultChannelGroup: "s.c.default_channel_group",
  deviceCategory: "s.device_category",
  operatingSystem: "s.operating_system",
  browser: "s.browser",
  country: "s.country",
  region: "s.region",
  city: "s.city",
  language: "s.language",
  landingPage: "s.landing_page",
};

/** Aggregates over visits for each number, by GA4 API name. */
export const EXPORT_METRICS: Record<string, string> = {
  sessions: "COUNT(*)",
  keyEvents: "SUM(s.key_events)",
  totalRevenue: "SUM(s.revenue)",
  engagedSessions: "COUNTIF(s.engaged)",
  averageSessionDuration: "AVG(s.duration_s)",
  screenPageViews: "SUM(s.page_views)",
  totalUsers: "COUNT(DISTINCT s.user_pseudo_id)",
  newUsers: "COUNT(DISTINCT IF(s.is_new, s.user_pseudo_id, NULL))",
  transactions: "SUM(s.transactions)",
  purchaseRevenue: "SUM(s.revenue)",
};

const IDENT = /^[A-Za-z0-9_]{1,64}$/;

/** Builds the query; `table` is the fully quoted `project.analytics_<id>.events_*`. */
export function ga4ExportSql(table: string, fields: { dimensions: string[]; metrics: string[] }): string {
  for (const d of fields.dimensions) if (!EXPORT_DIMENSIONS[d] || !IDENT.test(d)) throw new Error(`ga4 export: unknown column ${d}`);
  for (const m of fields.metrics) if (!EXPORT_METRICS[m] || !IDENT.test(m)) throw new Error(`ga4 export: unknown number ${m}`);
  const dims = fields.dimensions.map((d) => `IFNULL(CAST(${EXPORT_DIMENSIONS[d]} AS STRING), '(not set)') AS ${d}`);
  const mets = fields.metrics.map((m) => `${EXPORT_METRICS[m]} AS ${m}`);
  const groupBy = fields.dimensions.map((_, i) => String(i + 1)).join(", ");
  return `WITH ev AS (
  SELECT
    user_pseudo_id,
    (SELECT value.int_value FROM UNNEST(event_params) WHERE key = 'ga_session_id') AS sid,
    event_name, event_timestamp, event_date,
    (SELECT COALESCE(value.string_value, CAST(value.int_value AS STRING)) FROM UNNEST(event_params) WHERE key = 'session_engaged') AS engaged,
    (SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'page_location') AS page_location,
    session_traffic_source_last_click.cross_channel_campaign AS ccc,
    device.category AS device_category, device.operating_system AS operating_system, device.web_info.browser AS browser,
    device.language AS language, geo.country AS country, geo.region AS region, geo.city AS city,
    ecommerce.purchase_revenue AS purchase_revenue, ecommerce.transaction_id AS transaction_id
  FROM ${table}
  WHERE _TABLE_SUFFIX BETWEEN @from_suffix AND @to_suffix
),
s AS (
  SELECT
    user_pseudo_id,
    PARSE_DATE('%Y%m%d', MIN(event_date)) AS visit_date,
    ARRAY_AGG(ccc IGNORE NULLS ORDER BY event_timestamp LIMIT 1)[SAFE_OFFSET(0)] AS c,
    ANY_VALUE(device_category) AS device_category, ANY_VALUE(operating_system) AS operating_system,
    ANY_VALUE(browser) AS browser, ANY_VALUE(language) AS language,
    ANY_VALUE(country) AS country, ANY_VALUE(region) AS region, ANY_VALUE(city) AS city,
    REGEXP_EXTRACT(
      ARRAY_AGG(IF(event_name = 'page_view', page_location, NULL) IGNORE NULLS ORDER BY event_timestamp LIMIT 1)[SAFE_OFFSET(0)],
      r'^[A-Za-z]+://[^/?#]+([^#]*)') AS landing_page,
    LOGICAL_OR(engaged = '1') AS engaged,
    (MAX(event_timestamp) - MIN(event_timestamp)) / 1000000 AS duration_s,
    COUNTIF(event_name IN ('page_view', 'screen_view')) AS page_views,
    COUNTIF(event_name IN UNNEST(@key_events)) AS key_events,
    LOGICAL_OR(event_name = 'first_visit') AS is_new,
    IFNULL(SUM(IF(event_name = 'purchase', purchase_revenue, 0)), 0) AS revenue,
    COUNT(DISTINCT IF(event_name = 'purchase', transaction_id, NULL)) AS transactions
  FROM ev
  WHERE sid IS NOT NULL
  GROUP BY user_pseudo_id, sid
)
SELECT ${[...dims, ...mets].join(",\n  ")}
FROM s
WHERE s.visit_date BETWEEN @from_date AND @to_date
GROUP BY ${groupBy}`;
}

/** Export tables are named events_YYYYMMDD; returns that date as YYYY-MM-DD. */
export function exportTableDate(tableName: string): string | null {
  const m = /^events_(\d{4})(\d{2})(\d{2})$/.exec(tableName);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}
