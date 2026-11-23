import Papa from "papaparse";
import { isValidDate } from "../../lib/dates";

// Safe CSV parser + validator for the documented daily metrics template
// (docs/CONNECTORS.md#csv). Everything is validated on the server; the browser
// preview is informational only.

export const CSV_LIMITS = {
  maxBytes: 5 * 1024 * 1024,
  maxRows: 50_000,
  maxColumns: 30,
  maxCellLength: 300,
  maxErrorsReported: 200,
} as const;

export const REQUIRED_COLUMNS = ["date", "source", "campaign_name"] as const;
export const OPTIONAL_COLUMNS = [
  "campaign_id",
  "account_id",
  "account_name",
  "currency",
  "spend",
  "impressions",
  "clicks",
  "sessions",
  "conversions",
  "leads",
  "revenue",
  "revenue_type",
] as const;
const METRIC_COLUMNS = ["spend", "impressions", "clicks", "sessions", "conversions", "leads", "revenue"] as const;
const INT_COLUMNS = new Set(["impressions", "clicks", "sessions", "leads"]);

export interface CsvRow {
  date: string;
  source: string;
  account_id: string;
  account_name: string | null;
  campaign_id: string;
  campaign_name: string;
  currency: string | null;
  spend: number | null;
  impressions: number | null;
  clicks: number | null;
  sessions: number | null;
  conversions: number | null;
  leads: number | null;
  revenue: number | null;
  revenue_type: "attributed" | "billed" | null;
}

export interface CsvIssue {
  row: number | null; // 1-based data row number (header = row 0); null for file-level
  column: string | null;
  message: string;
}

export interface CsvSummary {
  rowCount: number;
  dateFrom: string | null;
  dateTo: string | null;
  sources: string[];
  currencies: string[];
  columnsPresent: string[];
  totals: Partial<Record<(typeof METRIC_COLUMNS)[number], number>>;
}

export interface CsvValidationResult {
  ok: boolean;
  rows: CsvRow[];
  errors: CsvIssue[];
  warnings: CsvIssue[];
  summary: CsvSummary;
}

export function slugify(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 60);
}

/** Strict numeric parsing: plain digits or comma thousands separators; no symbols, no exponent. */
export function parseNumber(raw: string): number | "invalid" | null {
  const s = raw.trim();
  if (s === "") return null;
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s);
  if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) return Number(s.replace(/,/g, ""));
  return "invalid";
}

export function validateCsv(text: string, opts: { today: string; byteSize?: number }): CsvValidationResult {
  const errors: CsvIssue[] = [];
  const warnings: CsvIssue[] = [];
  const emptySummary: CsvSummary = {
    rowCount: 0,
    dateFrom: null,
    dateTo: null,
    sources: [],
    currencies: [],
    columnsPresent: [],
    totals: {},
  };
  const fail = (message: string): CsvValidationResult => ({
    ok: false,
    rows: [],
    errors: [{ row: null, column: null, message }],
    warnings,
    summary: emptySummary,
  });

  const size = opts.byteSize ?? Buffer.byteLength(text, "utf8");
  if (size === 0) return fail("The file is empty.");
  if (size > CSV_LIMITS.maxBytes) return fail(`The file is larger than ${CSV_LIMITS.maxBytes / 1024 / 1024} MB.`);
  if (text.includes("\u0000")) return fail("The file looks binary, not a text CSV.");

  const clean = text.replace(/^﻿/, "");
  const parsed = Papa.parse<string[]>(clean, { skipEmptyLines: "greedy" });
  if (parsed.errors.length) {
    const e = parsed.errors[0]!;
    return fail(`The file could not be read as CSV (${e.message}${e.row !== undefined ? ` near row ${e.row}` : ""}).`);
  }
  const data = parsed.data;
  if (data.length < 2) return fail("The file has no data rows. The first row must be the column names.");
  const header = data[0]!.map((h) => h.trim().toLowerCase());
  if (header.length > CSV_LIMITS.maxColumns) return fail(`Too many columns (max ${CSV_LIMITS.maxColumns}).`);
  if (data.length - 1 > CSV_LIMITS.maxRows) return fail(`Too many rows (max ${CSV_LIMITS.maxRows.toLocaleString("en-US")}).`);

  const seen = new Set<string>();
  for (const h of header) {
    if (seen.has(h)) return fail(`Column "${h}" appears more than once.`);
    seen.add(h);
  }
  const missing = REQUIRED_COLUMNS.filter((c) => !header.includes(c));
  if (missing.length) return fail(`Missing required column(s): ${missing.join(", ")}.`);
  const known = new Set<string>([...REQUIRED_COLUMNS, ...OPTIONAL_COLUMNS]);
  const unknown = header.filter((h) => !known.has(h));
  if (unknown.length) warnings.push({ row: null, column: null, message: `Ignored unknown column(s): ${unknown.join(", ")}.` });
  if (!METRIC_COLUMNS.some((c) => header.includes(c))) {
    return fail(`Add at least one metric column: ${METRIC_COLUMNS.join(", ")}.`);
  }

  const idx = Object.fromEntries(header.map((h, i) => [h, i])) as Record<string, number>;
  const rows: CsvRow[] = [];
  const keys = new Map<string, number>();
  const addError = (row: number, column: string | null, message: string) => {
    if (errors.length < CSV_LIMITS.maxErrorsReported) errors.push({ row, column, message });
  };

  for (let r = 1; r < data.length; r++) {
    const cells = data[r]!;
    const get = (c: string): string => {
      const i = idx[c];
      return i === undefined ? "" : (cells[i] ?? "").trim();
    };
    if (cells.length !== header.length) {
      addError(r, null, `Row has ${cells.length} cells but the header has ${header.length}.`);
      continue;
    }
    if (cells.some((c) => c.length > CSV_LIMITS.maxCellLength)) {
      addError(r, null, `A cell is longer than ${CSV_LIMITS.maxCellLength} characters.`);
      continue;
    }
    let rowOk = true;
    const date = get("date");
    if (!isValidDate(date)) {
      addError(r, "date", `"${date}" is not a valid date. Use YYYY-MM-DD.`);
      rowOk = false;
    } else if (date > opts.today) {
      addError(r, "date", `${date} is in the future.`);
      rowOk = false;
    }
    const source = slugify(get("source"));
    if (!source) {
      addError(r, "source", "Source is required (for example: meta_ads, bing_ads, newsletter).");
      rowOk = false;
    }
    const campaignName = get("campaign_name");
    if (!campaignName) {
      addError(r, "campaign_name", "Campaign name is required. Use (none) for source-level totals.");
      rowOk = false;
    }
    const metrics: Record<string, number | null> = {};
    for (const col of METRIC_COLUMNS) {
      const raw = get(col);
      const n = parseNumber(raw);
      if (n === "invalid") {
        addError(r, col, `"${raw}" is not a valid non-negative number (no currency symbols or minus signs).`);
        rowOk = false;
        metrics[col] = null;
      } else if (n !== null && INT_COLUMNS.has(col) && !Number.isInteger(n)) {
        addError(r, col, `${col} must be a whole number.`);
        rowOk = false;
        metrics[col] = null;
      } else {
        metrics[col] = n;
      }
    }
    const currencyRaw = get("currency").toUpperCase();
    const needsCurrency = metrics.spend !== null || metrics.revenue !== null;
    if (currencyRaw && !/^[A-Z]{3}$/.test(currencyRaw)) {
      addError(r, "currency", `"${currencyRaw}" is not a 3-letter currency code (e.g. USD).`);
      rowOk = false;
    } else if (needsCurrency && !currencyRaw) {
      addError(r, "currency", "Currency is required when spend or revenue is filled in.");
      rowOk = false;
    }
    const rtRaw = get("revenue_type").toLowerCase();
    let revenueType: CsvRow["revenue_type"] = null;
    if (rtRaw) {
      if (rtRaw !== "attributed" && rtRaw !== "billed") {
        addError(r, "revenue_type", 'revenue_type must be "attributed" or "billed".');
        rowOk = false;
      } else revenueType = rtRaw;
    } else if (metrics.revenue !== null) {
      revenueType = "attributed";
    }
    if (!rowOk) continue;

    if (metrics.clicks !== null && metrics.impressions !== null && metrics.clicks! > metrics.impressions!) {
      warnings.push({ row: r, column: "clicks", message: "Clicks are higher than impressions. Please double-check this row." });
    }

    const accountId = slugify(get("account_id")) || "default";
    const campaignId = get("campaign_id") ? get("campaign_id").slice(0, 128) : `name:${slugify(campaignName) || "none"}`;
    const key = `${date}|${source}|${accountId}|${campaignId}`;
    const prev = keys.get(key);
    if (prev !== undefined) {
      addError(r, null, `Duplicate of row ${prev}: same date, source, account and campaign. Combine them into one row.`);
      continue;
    }
    keys.set(key, r);
    rows.push({
      date,
      source,
      account_id: accountId,
      account_name: get("account_name") || null,
      campaign_id: campaignId,
      campaign_name: campaignName,
      currency: currencyRaw || null,
      spend: metrics.spend ?? null,
      impressions: metrics.impressions ?? null,
      clicks: metrics.clicks ?? null,
      sessions: metrics.sessions ?? null,
      conversions: metrics.conversions ?? null,
      leads: metrics.leads ?? null,
      revenue: metrics.revenue ?? null,
      revenue_type: revenueType,
    });
  }

  const dates = rows.map((x) => x.date).sort();
  const totals: CsvSummary["totals"] = {};
  for (const col of METRIC_COLUMNS) {
    if (!header.includes(col)) continue;
    const vals = rows.map((x) => x[col]).filter((v): v is number => v !== null);
    if (vals.length) totals[col] = Number(vals.reduce((a, b) => a + b, 0).toFixed(6));
  }
  const currencies = [...new Set(rows.map((x) => x.currency).filter((c): c is string => !!c))].sort();
  if (currencies.length > 1) {
    warnings.push({
      row: null,
      column: "currency",
      message: `The file contains several currencies (${currencies.join(", ")}). Totals are shown per currency and are never converted.`,
    });
  }
  return {
    ok: errors.length === 0 && rows.length > 0,
    rows: errors.length === 0 ? rows : [],
    errors,
    warnings,
    summary: {
      rowCount: rows.length,
      dateFrom: dates[0] ?? null,
      dateTo: dates[dates.length - 1] ?? null,
      sources: [...new Set(rows.map((x) => x.source))].sort(),
      currencies,
      columnsPresent: header.filter((h) => known.has(h)),
      totals,
    },
  };
}
