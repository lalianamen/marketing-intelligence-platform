// Turns stored raw provider payloads into flat, labelled table rows for display.

/**
 * Field order of GA4 rows stored before the one-table change (values kept by position).
 * Fixed on purpose: those stored rows do not change when the catalog does.
 */
export const GA4_DIMENSIONS = ["date", "sessionCampaignId", "sessionCampaignName"];
export const GA4_METRICS = ["sessions", "keyEvents", "totalRevenue"];

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
    GA4_DIMENSIONS.forEach((n: string, i: number) => (out[n] = p.dimensions![i]?.value ?? ""));
    GA4_METRICS.forEach((n: string, i: number) => (out[n] = p.metrics![i]?.value ?? ""));
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
