// Business type profiles. They change WHAT the user sees first (sources to
// connect, headline KPIs, wording); the warehouse data model is identical for
// every type, so companies stay comparable and the schema stays maintainable.

export const BUSINESS_TYPES = ["local_service", "ecommerce", "digital_products", "retail_store", "b2b_leads", "other"] as const;
export type BusinessType = (typeof BUSINESS_TYPES)[number];

export interface BusinessProfile {
  label: string;
  description: string;
  /** What a "result" is called for this business. */
  resultNoun: string;
  /** Headline KPIs shown first on the dashboard, in order. */
  headline: ("spend" | "clicks" | "impressions" | "sessions" | "ctr" | "cpc" | "cpm")[];
  /** Questions this business usually asks (shown as guidance). */
  focus: string[];
  /** Provider ids to recommend first (live, sample or planned). */
  recommendedSources: string[];
  /** Extra CSV columns that matter for this type (documented, optional). */
  csvTips: string[];
}

export const BUSINESS_PROFILES: Record<BusinessType, BusinessProfile> = {
  local_service: {
    label: "Local service business",
    description: "HVAC, plumbing, repair, cleaning, home services, clinics.",
    resultNoun: "leads",
    headline: ["spend", "clicks", "cpc", "sessions"],
    focus: ["Cost per lead and per call", "Which source brings booked jobs", "Leads by day of week"],
    recommendedSources: ["google_ads", "google_local_services_ads", "google_business_profile", "ga4", "field_service_crm", "call_tracking", "yelp_ads", "csv"],
    csvTips: ["Put phone calls and form requests in the leads column.", "Put invoiced job revenue in revenue with revenue_type = billed."],
  },
  ecommerce: {
    label: "Online store (physical goods)",
    description: "Sells products online and ships them.",
    resultNoun: "orders",
    headline: ["spend", "clicks", "ctr", "sessions"],
    focus: ["Return on ad spend (ROAS)", "Cost per order", "Revenue by source"],
    recommendedSources: ["google_ads", "ga4", "meta_ads", "shopify", "stripe", "csv"],
    csvTips: ["Put orders in conversions and order revenue in revenue (attributed or billed)."],
  },
  digital_products: {
    label: "Digital products / subscriptions",
    description: "Software, online courses, memberships, apps.",
    resultNoun: "sign-ups",
    headline: ["spend", "clicks", "sessions", "ctr"],
    focus: ["Cost per sign-up", "Paid conversions", "Subscription revenue by source"],
    recommendedSources: ["ga4", "google_ads", "meta_ads", "stripe", "csv"],
    csvTips: ["Put sign-ups in conversions; paid subscriptions as billed revenue."],
  },
  retail_store: {
    label: "Physical store / venue",
    description: "Shop, restaurant, salon, showroom with walk-in customers.",
    resultNoun: "visits",
    headline: ["spend", "impressions", "clicks", "cpm"],
    focus: ["Store visits and direction requests", "Local reach", "In-store sales by period"],
    recommendedSources: ["google_business_profile", "google_ads", "meta_ads", "pos", "yelp_ads", "csv"],
    csvTips: ["Put in-store sales as billed revenue for the day."],
  },
  b2b_leads: {
    label: "B2B / lead generation",
    description: "Sells to businesses; sales team works the leads.",
    resultNoun: "leads",
    headline: ["spend", "clicks", "cpc", "sessions"],
    focus: ["Cost per qualified lead", "Lead-to-deal rate", "Pipeline value by source"],
    recommendedSources: ["google_ads", "ga4", "crm", "microsoft_ads", "csv"],
    csvTips: ["Put qualified leads in leads; closed-won value as billed revenue."],
  },
  other: {
    label: "Other",
    description: "Anything else.",
    resultNoun: "conversions",
    headline: ["spend", "impressions", "clicks", "sessions"],
    focus: ["Spend and results by source"],
    recommendedSources: ["google_ads", "ga4", "csv"],
    csvTips: [],
  },
};

export function profileFor(type: string | null | undefined): BusinessProfile {
  return BUSINESS_PROFILES[(BUSINESS_TYPES as readonly string[]).includes(type ?? "") ? (type as BusinessType) : "other"];
}
