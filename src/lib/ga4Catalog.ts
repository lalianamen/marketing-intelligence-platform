// What a GA4 property can provide through the Google Analytics Data API, grouped
// for people who are not analysts. "loaded" marks what this platform imports today.
// Field names are the official GA4 Data API dimension/metric API names.

export interface Ga4Field {
  name: string;
  kind: "dimension" | "metric";
  description: string;
  loaded?: boolean;
}

export interface Ga4Group {
  title: string;
  summary: string;
  note?: string;
  fields: Ga4Field[];
}

export const GA4_CATALOG: Ga4Group[] = [
  {
    title: "Date and campaigns",
    summary: "Which day, and which marketing campaign brought the visit.",
    fields: [
      { name: "date", kind: "dimension", description: "Calendar day in the property's time zone.", loaded: true },
      { name: "sessionCampaignId", kind: "dimension", description: "ID of the campaign that started the visit; \"(not set)\" when there was none.", loaded: true },
      { name: "sessionCampaignName", kind: "dimension", description: "Campaign name; for visits without a campaign GA4 puts the channel here, e.g. (organic), (direct).", loaded: true },
    ],
  },
  {
    title: "Traffic sources",
    summary: "Where visitors came from: Google search, ChatGPT, a newsletter, a partner site…",
    fields: [
      { name: "sessionSource", kind: "dimension", description: "The site or service, e.g. google, chatgpt.com, facebook.com." },
      { name: "sessionMedium", kind: "dimension", description: "The type of traffic, e.g. organic, cpc (paid), referral, email." },
      { name: "sessionDefaultChannelGroup", kind: "dimension", description: "GA4's grouping into channels: Organic Search, Paid Search, Direct, Referral, Email…" },
      { name: "firstUserSource / firstUserMedium", kind: "dimension", description: "Where a person came from the very first time (useful for sign-ups)." },
    ],
  },
  {
    title: "Visits and engagement",
    summary: "How many visits there were and whether people actually used the site.",
    fields: [
      { name: "sessions", kind: "metric", description: "Number of visits.", loaded: true },
      { name: "engagedSessions", kind: "metric", description: "Visits longer than 10 seconds, with 2+ pages or a key event." },
      { name: "engagementRate", kind: "metric", description: "Share of engaged visits." },
      { name: "averageSessionDuration", kind: "metric", description: "Average visit length in seconds." },
      { name: "screenPageViews", kind: "metric", description: "Pages (and app screens) viewed." },
    ],
  },
  {
    title: "Users",
    summary: "How many different people visited and how many were new.",
    fields: [
      { name: "totalUsers", kind: "metric", description: "People who visited at least once." },
      { name: "newUsers", kind: "metric", description: "People visiting for the first time." },
      { name: "activeUsers", kind: "metric", description: "People who were engaged during the period." },
    ],
  },
  {
    title: "Conversions and revenue",
    summary: "The results: sign-ups, purchases and money as GA4 counts them.",
    note: "Revenue is what GA4 recorded on the site; billed revenue comes from your payment system.",
    fields: [
      { name: "keyEvents", kind: "metric", description: "Actions marked as key events in GA4 (sign-up, purchase, form…).", loaded: true },
      { name: "totalRevenue", kind: "metric", description: "All revenue GA4 recorded: purchases, subscriptions, ads.", loaded: true },
      { name: "transactions", kind: "metric", description: "Number of purchases." },
      { name: "purchaseRevenue", kind: "metric", description: "Revenue from purchases only." },
    ],
  },
  {
    title: "Events",
    summary: "Every tracked action by name: clicks, sign-ups, video plays, downloads.",
    fields: [
      { name: "eventName", kind: "dimension", description: "Name of the action, e.g. sign_up, purchase, page_view." },
      { name: "eventCount", kind: "metric", description: "How many times it happened." },
    ],
  },
  {
    title: "Pages",
    summary: "Which pages people open and where they land first.",
    fields: [
      { name: "pagePath", kind: "dimension", description: "Address of the page, e.g. /pricing." },
      { name: "pageTitle", kind: "dimension", description: "Title of the page." },
      { name: "landingPage", kind: "dimension", description: "The first page of a visit." },
    ],
  },
  {
    title: "Devices and technology",
    summary: "Phone or computer, and which system and browser.",
    fields: [
      { name: "deviceCategory", kind: "dimension", description: "desktop, mobile or tablet." },
      { name: "operatingSystem", kind: "dimension", description: "iOS, Android, Windows, macOS…" },
      { name: "browser", kind: "dimension", description: "Chrome, Safari, Edge…" },
    ],
  },
  {
    title: "Location and language",
    summary: "Where visitors are and what language their browser uses.",
    fields: [
      { name: "country / region / city", kind: "dimension", description: "Visitor location as GA4 detects it." },
      { name: "language", kind: "dimension", description: "Browser language." },
    ],
  },
  {
    title: "Ecommerce items",
    summary: "Which products or plans were viewed and bought.",
    note: "Only if the site sends ecommerce events to GA4.",
    fields: [
      { name: "itemName", kind: "dimension", description: "Product or plan name." },
      { name: "itemsPurchased", kind: "metric", description: "Units bought." },
      { name: "itemRevenue", kind: "metric", description: "Revenue per product." },
    ],
  },
  {
    title: "Audience",
    summary: "Age group and gender of visitors.",
    note: "Needs Google signals in GA4; small numbers are hidden by Google for privacy.",
    fields: [
      { name: "userAgeBracket", kind: "dimension", description: "Age group, e.g. 25-34." },
      { name: "userGender", kind: "dimension", description: "Gender as estimated by Google." },
    ],
  },
  {
    title: "Google Ads (linked)",
    summary: "Ad clicks and cost inside GA4, when GA4 is linked to Google Ads.",
    fields: [
      { name: "sessionGoogleAdsCampaignName", kind: "dimension", description: "Google Ads campaign of the visit." },
      { name: "advertiserAdClicks / advertiserAdCost", kind: "metric", description: "Clicks and spend imported from Google Ads." },
    ],
  },
  {
    title: "Every raw event (BigQuery export)",
    summary: "All individual events with all their details, one row per event.",
    note: "Not available through the API: the GA4 owner turns on the free \"BigQuery links\" export in GA4 Admin. Much larger volume.",
    fields: [],
  },
];
