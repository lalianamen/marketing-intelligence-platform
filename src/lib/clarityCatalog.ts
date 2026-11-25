// Microsoft Clarity data a connector can collect into ONE table — the same model
// as GA4: base columns always on, chosen breakdowns add columns. Clarity's Data
// Export API allows at most 3 breakdowns per request and returns every number it
// has (traffic, scroll depth, engagement time, dead / rage / quick-back clicks,
// script errors…); those columns are shown as they come.
//
// Clarity gives only the last 24 hours (no dates): the platform loads once a day
// right after midnight and files the result under the previous day.

import type { Ga4Group } from "./ga4Catalog";

/** Clarity API dimension name for each stored column name. */
export const CLARITY_DIMENSIONS: Record<string, string> = {
  source: "Source",
  medium: "Medium",
  campaign: "Campaign",
  channel: "Channel",
  browser: "Browser",
  device: "Device",
  os: "OS",
  country: "Country/Region",
  url: "URL",
};

export const CLARITY_MAX_BREAKDOWNS = 3;

export const CLARITY_GROUPS: Ga4Group[] = [
  {
    id: "core",
    core: true,
    title: "Day and all Clarity numbers",
    summary:
      "Sessions, bot sessions, distinct users, pages per session, scroll depth, engagement time, dead / rage / quick-back clicks, excessive scrolling and script errors — every number Clarity provides. Always on.",
    dimensions: [{ name: "date", description: "The day the last 24 hours belong to (loaded right after midnight)." }],
    metrics: [],
  },
  {
    id: "traffic",
    title: "Traffic source",
    summary: "Where visitors came from.",
    dimensions: [
      { name: "source", description: "Referrer or utm_source, e.g. google." },
      { name: "medium", description: "utm_medium, e.g. cpc, organic." },
      { name: "campaign", description: "utm_campaign." },
      { name: "channel", description: "Clarity's channel grouping, e.g. Organic search, Direct." },
    ],
    metrics: [],
  },
  {
    id: "technology",
    title: "Device and technology",
    summary: "Phone or computer, system and browser.",
    dimensions: [
      { name: "device", description: "PC, Mobile, Tablet." },
      { name: "os", description: "Windows, iOS, Android…" },
      { name: "browser", description: "Chrome, Safari, Edge…" },
    ],
    metrics: [],
  },
  {
    id: "location",
    title: "Country",
    summary: "Where visitors are.",
    dimensions: [{ name: "country", description: "Country or region." }],
    metrics: [],
  },
  {
    id: "pages",
    title: "Pages",
    summary: "Which page the numbers belong to.",
    dimensions: [{ name: "url", description: "Page address." }],
    metrics: [],
  },
];
