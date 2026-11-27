// Meta Ads (Facebook + Instagram ads) data a connector can collect into ONE
// table — the same model as the other connectors: base columns always on, one
// optional breakdown. Source: the ad account's Insights (Marketing API), per
// campaign and day, in the ad account's time zone and currency.

import type { Ga4Group } from "./ga4Catalog";

export const META_MAX_BREAKDOWNS = 1;

/** Meta Insights breakdown name for each stored column name. */
export const META_BREAKDOWNS: Record<string, string> = {
  platform: "publisher_platform",
  country: "country",
};

export const META_GROUPS: Ga4Group[] = [
  {
    id: "core",
    core: true,
    title: "Day, campaign and results (dashboard)",
    summary: "Spend, impressions, clicks, purchases, leads and purchase value per campaign and day. Feeds the dashboard; always on.",
    dimensions: [
      { name: "date", description: "Day, in the ad account's time zone." },
      { name: "campaign_id", description: "Meta campaign ID." },
      { name: "campaign_name", description: "Campaign name." },
    ],
    metrics: [
      { name: "spend", description: "Money spent, in the ad account's currency." },
      { name: "impressions", description: "How often the ads were shown." },
      { name: "clicks", description: "Clicks on the ads (all clicks, as Meta counts them)." },
      { name: "purchases", description: "Purchases Meta attributes to the ads." },
      { name: "purchase_value", description: "Value of those purchases." },
      { name: "leads", description: "Leads Meta attributes to the ads (forms and site leads)." },
    ],
  },
  {
    id: "platform",
    title: "Facebook or Instagram",
    summary: "Where the ad was shown: Facebook, Instagram, Messenger, Audience Network.",
    note: "Choose one breakdown at a time.",
    dimensions: [{ name: "platform", description: "facebook, instagram, messenger, audience_network." }],
    metrics: [],
  },
  {
    id: "country",
    title: "Country",
    summary: "Where the people who saw the ads are.",
    note: "Choose one breakdown at a time.",
    dimensions: [{ name: "country", description: "Two-letter country code, e.g. US." }],
    metrics: [],
  },
];
