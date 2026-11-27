// "Your app's database" connector table: daily totals per event (no person-level rows).
import type { Ga4Group } from "./ga4Catalog";

export const APP_DB_GROUPS: Ga4Group[] = [
  {
    id: "core",
    core: true,
    title: "Day, event and totals",
    summary: "How many times each event happened per day (page views included) and the money of purchases. Always on.",
    dimensions: [
      { name: "date", description: "Day, in the company's time zone." },
      { name: "event", description: "Event name as your app records it (page_view = a page was opened)." },
    ],
    metrics: [
      { name: "count", description: "How many times it happened." },
      { name: "amount", description: "Money of purchases (live payments only)." },
    ],
  },
];
