// Stripe data a connector can collect into ONE table — the same model as GA4:
// base columns always on, chosen breakdowns add columns. Source: the account's
// balance transactions (every payment, refund, dispute, fee and payout that moved
// money). Amounts are in the currency's normal units (dollars, not cents).
// The dashboard gets billed revenue = payments minus refunds and lost disputes.

import type { Ga4Group } from "./ga4Catalog";

export const STRIPE_GROUPS: Ga4Group[] = [
  {
    id: "core",
    core: true,
    title: "Day, currency and money (dashboard)",
    summary: "Number of transactions and how much money moved per day and currency. Feeds the dashboard's revenue; always on.",
    dimensions: [
      { name: "date", description: "Day the transaction was created (your company's time zone)." },
      { name: "currency", description: "Currency, e.g. usd." },
    ],
    metrics: [
      { name: "transactions", description: "Number of balance transactions." },
      { name: "amount", description: "Gross amount (refunds and payouts are negative)." },
      { name: "fee", description: "Stripe fees." },
      { name: "net", description: "Amount minus fees — what actually reached the balance." },
    ],
  },
  {
    id: "category",
    title: "Kind of money movement",
    summary: "Payment, refund, dispute, fee, payout…",
    dimensions: [
      { name: "reporting_category", description: "Stripe's grouping: charge, refund, dispute, payout, fee, other_adjustment…" },
      { name: "type", description: "Exact transaction type, e.g. charge, payment, refund, stripe_fee, payout." },
    ],
    metrics: [],
  },
  {
    id: "status",
    title: "Availability",
    summary: "Whether the money is already available in the balance.",
    dimensions: [{ name: "status", description: "available or pending." }],
    metrics: [],
  },
  {
    id: "detail",
    title: "Each transaction",
    summary: "One row per transaction instead of daily totals.",
    note: "Adds one row per payment — many rows for busy accounts.",
    dimensions: [
      { name: "id", description: "Stripe balance transaction ID (txn_…)." },
      { name: "description", description: "Description Stripe stored with the transaction." },
    ],
    metrics: [],
  },
];
