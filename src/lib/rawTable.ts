// Raw data table on the connector page: columns (label → JSON path in the stored
// payload), and the URL parameters for period, filters, sorting and paging.

import { GA4_CORE, ga4Fields } from "./ga4Catalog";
import { addDays } from "./dates";
import { flattenRawPayload } from "./rawView";

export interface RawColumn {
  label: string;
  path: string[];
}

export type FilterOp = "contains" | "eq" | "gt" | "lt";
export const FILTER_OPS: { op: FilterOp; label: string }[] = [
  { op: "contains", label: "contains" },
  { op: "eq", label: "equals (any case)" },
  { op: "gt", label: ">" },
  { op: "lt", label: "<" },
];

/**
 * Columns of a connector's table. GA4 rows store every requested field by name
 * (rows loaded before the one-table change stored the base fields by position).
 * GA4's raw date (YYYYMMDD) is not shown: the Day column already has it.
 */
export function rawColumnsFor(origin: string, samplePayloads: string[], ga4Groups: unknown = []): RawColumn[] {
  if (origin === "ga4") {
    const legacy = samplePayloads.some((p) => /^\s*\{\s*"dimensions"\s*:\s*\[/.test(p));
    if (legacy) {
      return [
        ...GA4_CORE.dimensions.map((d, i) => ({ label: d.name, path: ["dimensions", String(i), "value"] })),
        ...GA4_CORE.metrics.map((m, i) => ({ label: m.name, path: ["metrics", String(i), "value"] })),
      ].filter((c) => c.label !== "date");
    }
    const f = ga4Fields(ga4Groups);
    return [...f.dimensions, ...f.metrics].filter((n) => n !== "date").map((n) => ({ label: n, path: [n] }));
  }
  const labels: string[] = [];
  for (const p of samplePayloads) for (const k of Object.keys(flattenRawPayload(origin, p))) if (!labels.includes(k) && labels.length < 30) labels.push(k);
  return labels.map((label) => ({ label, path: label.split(".") }));
}

export interface RawTableParams {
  from: string | null;
  to: string | null;
  preset: string; // "7" | "30" | "90" | "all" | "custom"
  filters: { col: string; op: FilterOp; value: string }[];
  sort: string; // "day" | "imported" | column label
  dir: "asc" | "desc";
  page: number;
  /** Filter columns chosen without a value yet (suggestions only). */
  suggestFor?: string[];
}

type SP = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";
const isDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);

/** Reads table settings from the URL. Default: last 30 complete days, newest first. */
export function parseRawTableParams(sp: SP, yesterday: string): RawTableParams {
  const preset = ["7", "30", "90", "all", "custom"].includes(one(sp.period)) ? one(sp.period) : "30";
  let from: string | null = null;
  let to: string | null = null;
  if (preset === "custom") {
    from = isDate(one(sp.from)) ? one(sp.from) : null;
    to = isDate(one(sp.to)) ? one(sp.to) : null;
  } else if (preset !== "all") {
    from = addDays(yesterday, -(Number(preset) - 1));
    to = yesterday;
  }
  const filters: RawTableParams["filters"] = [];
  const suggestFor: string[] = [];
  for (let i = 1; i <= 3; i++) {
    const col = one(sp[`f${i}c`]).slice(0, 80);
    const op = one(sp[`f${i}o`]) as FilterOp;
    const value = one(sp[`f${i}v`]).slice(0, 200).trim();
    if (col && value !== "" && FILTER_OPS.some((o) => o.op === op)) filters.push({ col, op, value });
    else if (col) suggestFor.push(col);
  }
  const page = Math.max(1, Math.min(10000, Number.parseInt(one(sp.page), 10) || 1));
  return { from, to, preset, filters, suggestFor, sort: one(sp.sort).slice(0, 80) || "day", dir: one(sp.dir) === "asc" ? "asc" : "desc", page };
}

/** URL query for the table, keeping everything else as is. */
export function rawTableQuery(base: Record<string, string>, p: RawTableParams, change: Partial<RawTableParams> = {}): string {
  const q = { ...p, ...change };
  const out = new URLSearchParams(base);
  out.set("period", q.preset);
  if (q.preset === "custom") {
    if (q.from) out.set("from", q.from);
    if (q.to) out.set("to", q.to);
  }
  q.filters.forEach((f, i) => {
    out.set(`f${i + 1}c`, f.col);
    out.set(`f${i + 1}o`, f.op);
    out.set(`f${i + 1}v`, f.value);
  });
  if (q.sort !== "day") out.set("sort", q.sort);
  if (q.dir !== "desc") out.set("dir", q.dir);
  if (q.page > 1) out.set("page", String(q.page));
  return out.toString();
}

/** CSV escaping (RFC 4180) with formula-injection protection for spreadsheet apps. */
export function csvCell(v: string): string {
  const safe = /^[=+\-@\t\r]/.test(v) && !/^-?\d+(\.\d+)?$/.test(v) ? `'${v}` : v;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** Value at a payload path as display text ("" when missing). */
export function valueAt(payload: unknown, path: string[]): string {
  let v: unknown = payload;
  for (const seg of path) v = v && typeof v === "object" ? (v as Record<string, unknown>)[seg] : undefined;
  return v === undefined || v === null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
}

/** Fields that are durations in seconds (shown as m:ss; stored and exported exactly). */
const DURATION_FIELDS = new Set(["averageSessionDuration", "userEngagementDuration"]);

/**
 * How a stored value is shown in the table. Only the display changes: filters,
 * sorting and CSV export use the exact stored value.
 */
export function displayValue(label: string, raw: string): string {
  if (raw === "" || !/^-?\d+(\.\d+)?(e-?\d+)?$/i.test(raw)) return raw;
  const n = Number(raw);
  if (!Number.isFinite(n)) return raw;
  if (DURATION_FIELDS.has(label)) {
    const total = Math.round(n);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = String(total % 60).padStart(2, "0");
    return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
  }
  if (Number.isInteger(n)) return raw;
  return String(Math.round(n * 100) / 100);
}
