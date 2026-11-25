// Raw data table on the connector page: columns (label → JSON path in the stored
// payload), and the URL parameters for period, filters, sorting and paging.

import { GA4_REPORTS } from "./ga4Catalog";
import { addDays } from "./dates";
import { flattenRawPayload } from "./rawView";

export interface RawColumn {
  label: string;
  path: string[];
}

export type FilterOp = "contains" | "eq" | "gt" | "lt";
export const FILTER_OPS: { op: FilterOp; label: string }[] = [
  { op: "contains", label: "contains" },
  { op: "eq", label: "equals" },
  { op: "gt", label: ">" },
  { op: "lt", label: "<" },
];

/** Columns of a report. GA4 core rows store values by position; other reports store named fields. */
export function rawColumnsFor(origin: string, source: string | undefined, samplePayloads: string[]): RawColumn[] {
  if (origin === "ga4" && (!source || source === "ga4")) {
    const core = GA4_REPORTS.find((r) => r.core)!;
    return [
      ...core.dimensions.map((d, i) => ({ label: d.name, path: ["dimensions", String(i), "value"] })),
      ...core.metrics.map((m, i) => ({ label: m.name, path: ["metrics", String(i), "value"] })),
    ];
  }
  if (origin === "ga4" && source?.startsWith("ga4:")) {
    const report = GA4_REPORTS.find((r) => r.id === source.slice(4));
    if (report) return [...report.dimensions, ...report.metrics].map((f) => ({ label: f.name, path: [f.name] }));
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
  for (let i = 1; i <= 3; i++) {
    const col = one(sp[`f${i}c`]).slice(0, 80);
    const op = one(sp[`f${i}o`]) as FilterOp;
    const value = one(sp[`f${i}v`]).slice(0, 200);
    if (col && value !== "" && FILTER_OPS.some((o) => o.op === op)) filters.push({ col, op, value });
  }
  const page = Math.max(1, Math.min(10000, Number.parseInt(one(sp.page), 10) || 1));
  return { from, to, preset, filters, sort: one(sp.sort).slice(0, 80) || "day", dir: one(sp.dir) === "asc" ? "asc" : "desc", page };
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
