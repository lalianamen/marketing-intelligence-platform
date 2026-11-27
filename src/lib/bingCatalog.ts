// Bing Webmaster Tools data a connector can collect into ONE table — the same
// model as Search Console: base columns always on, one optional breakdown.
//
// Sources (Bing Webmaster API, JSON, API key):
// - GetRankAndTrafficStats: clicks and impressions per day for the whole site.
//   Microsoft: "updated every day"; includes Web, Chat, News, Images, Videos and
//   Knowledge Panel. Feeds the dashboard.
// - GetQueryStats / GetPageStats: top search queries / top pages with clicks,
//   impressions and average positions. Microsoft: "updated every week". Bing
//   returns only top queries and pages, so these rows add up to less than the day.
// Bing has no request that splits by query and page together, so only one
// breakdown can be chosen at a time.

import type { Ga4Group } from "./ga4Catalog";

export const BING_MAX_BREAKDOWNS = 1;

export const BING_GROUPS: Ga4Group[] = [
  {
    id: "core",
    core: true,
    title: "Day and results (dashboard)",
    summary: "Clicks and impressions from Bing per day. Feeds the dashboard; always on.",
    dimensions: [{ name: "date", description: "Calendar day, as Bing reports it." }],
    metrics: [
      { name: "clicks", description: "Clicks from Bing to your site." },
      { name: "impressions", description: "How often your site appeared on Bing (web, chat, news, images, videos)." },
      { name: "avg_click_position", description: "Average position when clicked (query and page rows only; 1 = top)." },
      { name: "avg_impression_position", description: "Average position when shown (query and page rows only; 1 = top)." },
    ],
  },
  {
    id: "queries",
    title: "Search queries",
    summary: "What people typed in Bing before they saw or clicked your site.",
    note: "Bing returns only top queries and refreshes them once a week; rows add up to less than the day's total. Choose either queries or pages.",
    dimensions: [{ name: "query", description: "The search text." }],
    metrics: [],
  },
  {
    id: "pages",
    title: "Pages",
    summary: "Which page of your site appeared on Bing.",
    note: "Bing returns only top pages and refreshes them once a week. Choose either queries or pages.",
    dimensions: [{ name: "page", description: "The full address of the page." }],
    metrics: [],
  },
];
