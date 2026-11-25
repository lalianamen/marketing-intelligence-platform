// What a GA4 property can provide through the Google Analytics Data API, as
// reports a user can switch on per connector. The "core" report feeds the
// dashboard and is always on; every other report is an extra GA4 runReport
// whose rows are stored as raw data (source "ga4:<id>") and never mixed into
// dashboard totals. Field names are official GA4 Data API API names; each
// report keeps dimensions and metrics that GA4 allows together.

export interface Ga4Field {
  name: string;
  description: string;
}

export interface Ga4Report {
  id: string;
  title: string;
  summary: string;
  note?: string;
  /** Always on: feeds the dashboard. */
  core?: boolean;
  /** Not available through the API (shown for information only). */
  unavailable?: boolean;
  dimensions: Ga4Field[];
  metrics: Ga4Field[];
}

const DATE: Ga4Field = { name: "date", description: "Calendar day in the property's time zone." };

export const GA4_REPORTS: Ga4Report[] = [
  {
    id: "core",
    core: true,
    title: "Campaigns and channels (dashboard)",
    summary: "Visits, key events and revenue per day and campaign. Feeds the dashboard; always on.",
    dimensions: [
      DATE,
      { name: "sessionCampaignId", description: "ID of the campaign that started the visit; \"(not set)\" when there was none." },
      { name: "sessionCampaignName", description: "Campaign name; for visits without a campaign GA4 puts the channel here, e.g. (organic), (direct)." },
    ],
    metrics: [
      { name: "sessions", description: "Number of visits." },
      { name: "keyEvents", description: "Actions marked as key events in GA4 (sign-up, purchase, form…)." },
      { name: "totalRevenue", description: "All revenue GA4 recorded: purchases, subscriptions, ads." },
    ],
  },
  {
    id: "traffic_sources",
    title: "Traffic sources",
    summary: "Where visitors came from: Google search, ChatGPT, a newsletter, a partner site…",
    dimensions: [
      DATE,
      { name: "sessionSource", description: "The site or service, e.g. google, chatgpt.com, facebook.com." },
      { name: "sessionMedium", description: "The type of traffic, e.g. organic, cpc (paid), referral, email." },
      { name: "sessionDefaultChannelGroup", description: "GA4's channel grouping: Organic Search, Paid Search, Direct, Referral, Email…" },
    ],
    metrics: [
      { name: "sessions", description: "Visits." },
      { name: "engagedSessions", description: "Visits longer than 10 seconds, with 2+ pages or a key event." },
      { name: "totalUsers", description: "People." },
      { name: "newUsers", description: "First-time visitors." },
      { name: "keyEvents", description: "Key events." },
      { name: "totalRevenue", description: "Revenue." },
    ],
  },
  {
    id: "engagement",
    title: "Visits and engagement",
    summary: "Whether people actually used the site, per day.",
    dimensions: [DATE],
    metrics: [
      { name: "sessions", description: "Visits." },
      { name: "engagedSessions", description: "Engaged visits." },
      { name: "engagementRate", description: "Share of engaged visits (0–1)." },
      { name: "averageSessionDuration", description: "Average visit length in seconds." },
      { name: "screenPageViews", description: "Pages and app screens viewed." },
      { name: "bounceRate", description: "Share of visits that were not engaged (0–1)." },
    ],
  },
  {
    id: "users",
    title: "Users",
    summary: "How many different people visited and how many were new, per day.",
    dimensions: [DATE],
    metrics: [
      { name: "totalUsers", description: "People who visited at least once." },
      { name: "newUsers", description: "People visiting for the first time." },
      { name: "activeUsers", description: "People who were engaged." },
    ],
  },
  {
    id: "conversions",
    title: "Conversions and revenue",
    summary: "Purchases and money as GA4 recorded them on the site, per day.",
    note: "GA4 revenue is what the site reported; billed revenue comes from your payment system.",
    dimensions: [DATE],
    metrics: [
      { name: "keyEvents", description: "Key events." },
      { name: "transactions", description: "Number of purchases." },
      { name: "purchaseRevenue", description: "Revenue from purchases only." },
      { name: "totalRevenue", description: "All revenue." },
    ],
  },
  {
    id: "events",
    title: "Events",
    summary: "Every tracked action by name: clicks, sign-ups, video plays, downloads.",
    dimensions: [DATE, { name: "eventName", description: "Name of the action, e.g. sign_up, purchase, page_view." }],
    metrics: [
      { name: "eventCount", description: "How many times it happened." },
      { name: "totalUsers", description: "People who did it." },
    ],
  },
  {
    id: "pages",
    title: "Pages",
    summary: "Which pages people open.",
    dimensions: [
      DATE,
      { name: "pagePath", description: "Address of the page, e.g. /pricing." },
      { name: "pageTitle", description: "Title of the page." },
    ],
    metrics: [
      { name: "screenPageViews", description: "Views." },
      { name: "activeUsers", description: "People who viewed it." },
    ],
  },
  {
    id: "landing_pages",
    title: "Landing pages",
    summary: "The first page of each visit, and what those visits led to.",
    dimensions: [DATE, { name: "landingPage", description: "The first page of a visit." }],
    metrics: [
      { name: "sessions", description: "Visits that started on this page." },
      { name: "engagedSessions", description: "Engaged visits." },
      { name: "keyEvents", description: "Key events in those visits." },
    ],
  },
  {
    id: "devices",
    title: "Devices and technology",
    summary: "Phone or computer, and which system and browser.",
    dimensions: [
      DATE,
      { name: "deviceCategory", description: "desktop, mobile or tablet." },
      { name: "operatingSystem", description: "iOS, Android, Windows, macOS…" },
      { name: "browser", description: "Chrome, Safari, Edge…" },
    ],
    metrics: [
      { name: "sessions", description: "Visits." },
      { name: "totalUsers", description: "People." },
      { name: "keyEvents", description: "Key events." },
    ],
  },
  {
    id: "geo",
    title: "Location and language",
    summary: "Where visitors are and what language their browser uses.",
    dimensions: [
      DATE,
      { name: "country", description: "Country." },
      { name: "region", description: "State or region." },
      { name: "city", description: "City." },
      { name: "language", description: "Browser language." },
    ],
    metrics: [
      { name: "sessions", description: "Visits." },
      { name: "totalUsers", description: "People." },
    ],
  },
  {
    id: "ecommerce_items",
    title: "Ecommerce items",
    summary: "Which products or plans were viewed and bought.",
    note: "Only if the site sends ecommerce events to GA4.",
    dimensions: [DATE, { name: "itemName", description: "Product or plan name." }],
    metrics: [
      { name: "itemsViewed", description: "Times viewed." },
      { name: "itemsPurchased", description: "Units bought." },
      { name: "itemRevenue", description: "Revenue per product." },
    ],
  },
  {
    id: "audience",
    title: "Audience",
    summary: "Age group and gender of visitors.",
    note: "Needs Google signals in GA4; Google hides small numbers for privacy.",
    dimensions: [
      DATE,
      { name: "userAgeBracket", description: "Age group, e.g. 25-34." },
      { name: "userGender", description: "Gender as estimated by Google." },
    ],
    metrics: [
      { name: "totalUsers", description: "People." },
      { name: "sessions", description: "Visits." },
    ],
  },
  {
    id: "google_ads",
    title: "Google Ads (linked)",
    summary: "Ad clicks and cost inside GA4.",
    note: "Only when GA4 is linked to Google Ads; otherwise GA4 rejects this report.",
    dimensions: [DATE, { name: "sessionGoogleAdsCampaignName", description: "Google Ads campaign of the visit." }],
    metrics: [
      { name: "advertiserAdClicks", description: "Ad clicks imported from Google Ads." },
      { name: "advertiserAdCost", description: "Ad spend imported from Google Ads." },
      { name: "sessions", description: "Visits." },
    ],
  },
  {
    id: "raw_events",
    unavailable: true,
    title: "Every raw event (BigQuery export)",
    summary: "All individual events with all their details, one row per event.",
    note: "Not available through the API: the GA4 owner turns on the free \"BigQuery links\" export in GA4 Admin. Much larger volume.",
    dimensions: [],
    metrics: [],
  },
];

/** Reports a user can switch on (not core, not informational). */
export const GA4_OPTIONAL_REPORTS = GA4_REPORTS.filter((r) => !r.core && !r.unavailable);

export function ga4ReportById(id: string): Ga4Report | undefined {
  return GA4_REPORTS.find((r) => r.id === id);
}

/** Keeps only known, switchable report ids, in catalog order. */
export function sanitizeGa4Reports(ids: unknown): string[] {
  const list = Array.isArray(ids) ? ids.map(String) : [];
  return GA4_OPTIONAL_REPORTS.map((r) => r.id).filter((id) => list.includes(id));
}
