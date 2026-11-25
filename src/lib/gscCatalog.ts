// Google Search Console data a connector can collect into ONE table — the same
// model as GA4 (see ga4Catalog.ts): base columns always on, each switched-on
// breakdown adds a column, one request per load. Field names are the official
// Search Console API names.
//
// Search Console hides rare search queries for privacy, so rows split by query
// add up to less than the day's total. The dashboard therefore uses a separate
// per-day total, never the sum of the table rows.

import type { Ga4Group } from "./ga4Catalog";

export const GSC_GROUPS: Ga4Group[] = [
  {
    id: "core",
    core: true,
    title: "Day and results (dashboard)",
    summary: "Clicks and impressions from Google Search per day. Feeds the dashboard; always on.",
    dimensions: [{ name: "date", description: "Calendar day (Pacific Time, as Search Console reports it; shown in the Day column)." }],
    metrics: [
      { name: "clicks", description: "Clicks from Google Search results to your site." },
      { name: "impressions", description: "How often your site appeared in search results." },
      { name: "ctr", description: "Clicks ÷ impressions for the row (not added up)." },
      { name: "position", description: "Average position in search results for the row (not added up; 1 = top)." },
    ],
  },
  {
    id: "queries",
    title: "Search queries",
    summary: "What people typed in Google before they saw or clicked your site.",
    note: "Google hides rare queries for privacy, so rows add up to less than the day's total.",
    dimensions: [{ name: "query", description: "The search text, e.g. \"ac repair los angeles\"." }],
    metrics: [],
  },
  {
    id: "pages",
    title: "Pages",
    summary: "Which page of your site appeared in the results.",
    dimensions: [{ name: "page", description: "The full address of the page." }],
    metrics: [],
  },
  {
    id: "countries",
    title: "Country",
    summary: "Where the people searching were.",
    dimensions: [{ name: "country", description: "Country code (ISO 3166-1 alpha-3), e.g. usa." }],
    metrics: [],
  },
  {
    id: "devices",
    title: "Device",
    summary: "Phone, computer or tablet.",
    dimensions: [{ name: "device", description: "DESKTOP, MOBILE or TABLET." }],
    metrics: [],
  },
];
