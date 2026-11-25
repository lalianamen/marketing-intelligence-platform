// Turns stored raw provider payloads into flat, labelled table rows for display.

import { GA4_REPORTS } from "./ga4Catalog";

const CORE = GA4_REPORTS.find((r) => r.core)!;
/** GA4 core report columns the connector requests, in order; raw records keep values in this order. */
export const GA4_DIMENSIONS = CORE.dimensions.map((d) => d.name);
export const GA4_METRICS = CORE.metrics.map((m) => m.name);

function flatten(value: unknown, prefix: string, out: Record<string, string>): void {
  if (value === null || value === undefined) {
    if (prefix) out[prefix] = "";
    return;
  }
  if (Array.isArray(value) || typeof value === "object") {
    const entries = Array.isArray(value) ? value.map((v, i) => [String(i), v] as const) : Object.entries(value as Record<string, unknown>);
    if (entries.length === 0 && prefix) out[prefix] = "";
    for (const [k, v] of entries) flatten(v, prefix ? `${prefix}.${k}` : k, out);
    return;
  }
  out[prefix || "value"] = String(value);
}

export function flattenRawPayload(origin: string, payloadJson: string): Record<string, string> {
  let payload: unknown;
  try {
    payload = JSON.parse(payloadJson);
  } catch {
    return { raw: payloadJson };
  }
  const p = payload as { dimensions?: { value?: string }[]; metrics?: { value?: string }[] };
  if (origin === "ga4" && Array.isArray(p?.dimensions) && Array.isArray(p?.metrics)) {
    const out: Record<string, string> = {};
    GA4_DIMENSIONS.forEach((n, i) => (out[n] = p.dimensions![i]?.value ?? ""));
    GA4_METRICS.forEach((n, i) => (out[n] = p.metrics![i]?.value ?? ""));
    return out;
  }
  const out: Record<string, string> = {};
  flatten(payload, "", out);
  return out;
}

/** Column order: first-seen order across rows, capped. */
export function rawColumns(rows: Record<string, string>[], max = 30): string[] {
  const cols: string[] = [];
  for (const r of rows) for (const k of Object.keys(r)) if (!cols.includes(k) && cols.length < max) cols.push(k);
  return cols;
}
