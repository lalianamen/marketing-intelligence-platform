// GA4 data a connector can collect into ONE table. The base group (day, campaign
// or channel, sessions, key events, revenue) feeds the dashboard and is always
// on. Every other group adds its columns to the same GA4 request, so the table
// stays a single table: one row per day × campaign × the chosen breakdowns.
//
// Only groups that can be combined honestly are offered: breakdowns of the visit
// (session-scoped dimensions), where rows still add up to the day's sessions,
// and per-row numbers. Events, pages, items and audience are not offered: in one
// table they would repeat visits. GA4 allows at most 9 dimensions and 10 metrics
// per request. Field names are official GA4 Data API API names.

export interface Ga4Field {
  name: string;
  description: string;
}

export interface Ga4Group {
  id: string;
  title: string;
  summary: string;
  note?: string;
  /** Always on: feeds the dashboard. */
  core?: boolean;
  dimensions: Ga4Field[];
  metrics: Ga4Field[];
}

export const GA4_MAX_DIMENSIONS = 9;
export const GA4_MAX_METRICS = 10;

export const GA4_GROUPS: Ga4Group[] = [
  {
    id: "core",
    core: true,
    title: "Day, campaign and results (dashboard)",
    summary: "Visits, key events and revenue per day and campaign or channel. Feeds the dashboard; always on.",
    dimensions: [
      { name: "date", description: "Calendar day in the property's time zone (shown in the Day column)." },
      { name: "sessionCampaignName", description: "Campaign name; for visits without a campaign GA4 puts the channel here, e.g. (organic), (direct)." },
    ],
    metrics: [
      { name: "sessions", description: "Number of visits." },
      { name: "keyEvents", description: "Actions marked as key events in GA4 (sign-up, purchase, form…)." },
      { name: "totalRevenue", description: "All revenue GA4 recorded: purchases, subscriptions, ads." },
    ],
  },
  {
    id: "campaign_ids",
    title: "Campaign ID",
    summary: "The ad platform's campaign number, next to the campaign name.",
    note: "Only useful with tagged ad campaigns; without them it is always \"(not set)\".",
    dimensions: [
      { name: "sessionCampaignId", description: "ID of the campaign that started the visit; \"(not set)\" when there was none." },
    ],
    metrics: [],
  },
  {
    id: "traffic_sources",
    title: "Traffic sources",
    summary: "Where visitors came from: Google search, ChatGPT, a newsletter, a partner site…",
    dimensions: [
      { name: "sessionSource", description: "The site or service, e.g. google, chatgpt.com, facebook.com." },
      { name: "sessionMedium", description: "The type of traffic, e.g. organic, cpc (paid), referral, email." },
      { name: "sessionDefaultChannelGroup", description: "GA4's channel grouping: Organic Search, Paid Search, Direct, Referral, Email…" },
    ],
    metrics: [],
  },
  {
    id: "devices",
    title: "Devices and technology",
    summary: "Phone or computer, and which system and browser.",
    dimensions: [
      { name: "deviceCategory", description: "desktop, mobile or tablet." },
      { name: "operatingSystem", description: "iOS, Android, Windows, macOS…" },
      { name: "browser", description: "Chrome, Safari, Edge…" },
    ],
    metrics: [],
  },
  {
    id: "geo",
    title: "Location and language",
    summary: "Where visitors are and what language their browser uses.",
    note: "Adds many rows (one per city).",
    dimensions: [
      { name: "country", description: "Country." },
      { name: "region", description: "State or region." },
      { name: "city", description: "City." },
      { name: "language", description: "Browser language." },
    ],
    metrics: [],
  },
  {
    id: "landing_pages",
    title: "Landing pages",
    summary: "The first page of each visit.",
    dimensions: [{ name: "landingPage", description: "The first page of a visit, e.g. /pricing." }],
    metrics: [],
  },
  {
    id: "engagement",
    title: "Engagement",
    summary: "Whether people actually used the site.",
    dimensions: [],
    metrics: [
      { name: "engagedSessions", description: "Visits longer than 10 seconds, with 2+ pages or a key event." },
      { name: "averageSessionDuration", description: "Average visit length in seconds (per row; not added up)." },
      { name: "screenPageViews", description: "Pages and app screens viewed." },
    ],
  },
  {
    id: "users",
    title: "Users",
    summary: "How many different people visited and how many were new.",
    note: "People are counted per row; the same person can appear in several rows, so do not add users up.",
    dimensions: [],
    metrics: [
      { name: "totalUsers", description: "People who visited." },
      { name: "newUsers", description: "People visiting for the first time." },
    ],
  },
  {
    id: "conversions",
    title: "Purchases",
    summary: "Purchases as GA4 recorded them on the site.",
    note: "GA4 revenue is what the site reported; billed revenue comes from your payment system.",
    dimensions: [],
    metrics: [
      { name: "transactions", description: "Number of purchases." },
      { name: "purchaseRevenue", description: "Revenue from purchases only." },
    ],
  },
];

export const GA4_CORE = GA4_GROUPS.find((g) => g.core)!;
/** Groups a user can switch on. */
export const GA4_OPTIONAL_GROUPS = GA4_GROUPS.filter((g) => !g.core);

export function ga4GroupById(id: string): Ga4Group | undefined {
  return GA4_GROUPS.find((g) => g.id === id);
}

export interface Ga4OptionalField extends Ga4Field {
  group: string;
  kind: "dimension" | "metric";
}

/** Every field a user can switch on, with its group (plan tiers attach to groups), in catalog order. */
export const GA4_OPTIONAL_FIELDS: Ga4OptionalField[] = GA4_OPTIONAL_GROUPS.flatMap((g) => [
  ...g.dimensions.map((f) => ({ ...f, group: g.id, kind: "dimension" as const })),
  ...g.metrics.map((f) => ({ ...f, group: g.id, kind: "metric" as const })),
]);

export function isGa4SelectionItem(item: string): boolean {
  return GA4_OPTIONAL_FIELDS.some((f) => f.name === item) || GA4_OPTIONAL_GROUPS.some((g) => g.id === item);
}

/**
 * The chosen optional fields, in catalog order. The saved list holds field names;
 * a whole group id (how earlier settings were saved) means all of its fields.
 */
export function sanitizeGa4Selection(items: unknown): string[] {
  const list = Array.isArray(items) ? items.map(String) : [];
  return GA4_OPTIONAL_FIELDS.filter((f) => list.includes(f.name) || list.includes(f.group)).map((f) => f.name);
}

/** The one GA4 request: base fields first, then the chosen fields, in catalog order. */
export function ga4Fields(selection: unknown): { dimensions: string[]; metrics: string[] } {
  const chosen = sanitizeGa4Selection(selection);
  const dimensions = GA4_CORE.dimensions.map((d) => d.name);
  const metrics = GA4_CORE.metrics.map((m) => m.name);
  for (const f of GA4_OPTIONAL_FIELDS) {
    if (!chosen.includes(f.name)) continue;
    const list = f.kind === "dimension" ? dimensions : metrics;
    if (!list.includes(f.name)) list.push(f.name);
  }
  return { dimensions, metrics };
}

/** null when the selection fits in one GA4 request, otherwise a plain explanation. */
export function ga4SelectionProblem(selection: unknown): string | null {
  const { dimensions, metrics } = ga4Fields(selection);
  if (dimensions.length > GA4_MAX_DIMENSIONS) {
    return `GA4 allows at most ${GA4_MAX_DIMENSIONS} breakdowns in one table; this choice needs ${dimensions.length}. Switch another breakdown off first.`;
  }
  if (metrics.length > GA4_MAX_METRICS) {
    return `GA4 allows at most ${GA4_MAX_METRICS} numbers in one table; this choice needs ${metrics.length}. Switch another number off first.`;
  }
  return null;
}
