// Funnel definitions shared by the server and the UI (client-safe).
// A funnel is an ordered list of stages; each stage is reached when a person has
// any of the stage's events. "page_view" is the visit stage (a row in page_views).

export interface FunnelStage {
  label: string;
  events: string[];
}

export const MAX_STAGES = 8;
export const PAGE_VIEW = "page_view";

/** A sensible default; the user can change it (Funnel → Stages). */
export const DEFAULT_STAGES: FunnelStage[] = [
  { label: "Visited", events: [PAGE_VIEW] },
  { label: "Signed up", events: ["account_created", "signup", "sign_up"] },
  { label: "Trial", events: ["trial_started"] },
  { label: "Checkout", events: ["checkout_started", "begin_checkout"] },
  { label: "Paid", events: ["purchase", "subscription_started"] },
];

const EVENT_RE = /^[A-Za-z0-9_.:-]{1,80}$/;

/** Cleans stages from settings or a form: at most 8, each with a label and 1–20 valid event names. */
export function sanitizeStages(value: unknown): FunnelStage[] {
  if (!Array.isArray(value)) return DEFAULT_STAGES;
  const out: FunnelStage[] = [];
  for (const s of value.slice(0, MAX_STAGES)) {
    const label = String((s as FunnelStage)?.label ?? "").trim().slice(0, 40);
    const events = [...new Set((Array.isArray((s as FunnelStage)?.events) ? (s as FunnelStage).events : []).map(String).filter((e) => EVENT_RE.test(e)))].slice(0, 20);
    if (label && events.length) out.push({ label, events });
  }
  return out.length >= 2 ? out : DEFAULT_STAGES;
}

/** Channel of a first touch, from the referring site and the app's own source label. */
export function channelOf(refHost: string | null, src: string | null): string {
  const h = (refHost ?? "").toLowerCase();
  const s = (src ?? "").toLowerCase();
  if (/^(fb|facebook|ig|instagram|tt|tiktok|tg|telegram|yt|youtube)$/.test(s)) return "Social";
  if (/^(em|email|newsletter)([-_]|$)/.test(s)) return "Email";
  if (!h) return "Direct / unknown";
  if (/(^|\.)mail\.|gmail|outlook|com\.google\.android\.gm$|yahoo\.com\/mail/.test(h)) return "Email";
  if (/chatgpt|openai|perplexity|gemini\.google|copilot|claude\.ai|meta\.ai|qwen|deepseek/.test(h)) return "AI assistants";
  if (/google\.|googlequicksearchbox|bing\.|duckduckgo|yahoo\.|ecosia|brave\.|yandex\.|baidu\./.test(h)) return "Search";
  if (/facebook|instagram|tiktok|twitter|x\.com|t\.co$|linkedin|reddit|youtube|pinterest|t\.me|telegram/.test(h)) return "Social";
  return "Referral";
}

/** Stages offered after connecting: the defaults, plus a "free test" step when the app records one. */
export function suggestStages(events: string[]): FunnelStage[] {
  const has = (e: string) => events.includes(e);
  const pick = (label: string, list: string[]) => ({ label, events: list.filter(has) });
  const stages: FunnelStage[] = [{ label: "Visited", events: [PAGE_VIEW] }];
  for (const s of [
    pick("Free test", ["sample_started"]),
    pick("Signed up", ["account_created", "signup", "sign_up"]),
    pick("Trial", ["trial_started"]),
    pick("Checkout", ["checkout_started", "begin_checkout"]),
    pick("Paid", ["purchase", "subscription_started"]),
  ])
    if (s.events.length) stages.push(s);
  return stages.length >= 2 ? stages : DEFAULT_STAGES;
}
