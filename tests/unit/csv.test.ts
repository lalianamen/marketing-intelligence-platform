import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CSV_LIMITS, parseNumber, slugify, validateCsv } from "@/server/ingestion/csv";
import { normalizeCsvRows } from "@/server/ingestion/normalize";

const TODAY = "2026-11-22";
const H = "date,source,campaign_name,currency,spend,impressions,clicks,conversions,leads,revenue";

describe("parseNumber", () => {
  it("accepts plain and comma-thousands numbers, rejects symbols/negatives/exponents", () => {
    expect(parseNumber("")).toBeNull();
    expect(parseNumber("12")).toBe(12);
    expect(parseNumber("1,234.50")).toBe(1234.5);
    expect(parseNumber("$12")).toBe("invalid");
    expect(parseNumber("-5")).toBe("invalid");
    expect(parseNumber("1e5")).toBe("invalid");
    expect(parseNumber("12,5")).toBe("invalid"); // ambiguous decimal comma
  });
});

describe("validateCsv", () => {
  it("accepts the sample template file", () => {
    const text = readFileSync("public/sample-marketing-data.csv", "utf8");
    const r = validateCsv(text, { today: "2026-11-22" });
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.summary.rowCount).toBeGreaterThan(50);
    expect(r.summary.sources).toContain("meta_ads");
  });

  it("reports missing required columns", () => {
    const r = validateCsv("date,spend\n2026-11-01,5\n", { today: TODAY });
    expect(r.ok).toBe(false);
    expect(r.errors[0]!.message).toMatch(/source, campaign_name/);
  });

  it("requires at least one metric column", () => {
    const r = validateCsv("date,source,campaign_name\n2026-11-01,x,y\n", { today: TODAY });
    expect(r.ok).toBe(false);
  });

  it("rejects bad dates, future dates, bad numbers and missing currency with row/column detail", () => {
    const r = validateCsv(
      [H, "2026-13-01,meta,A,USD,1,1,1,,,", "2026-12-01,meta,A,USD,1,1,1,,,", "2026-11-01,meta,A,USD,$5,1,1,,,", "2026-11-02,meta,A,,5,1,1,,,"].join("\n"),
      { today: TODAY },
    );
    expect(r.ok).toBe(false);
    expect(r.rows).toEqual([]);
    const cols = r.errors.map((e) => `${e.row}:${e.column}`);
    expect(cols).toEqual(["1:date", "2:date", "3:spend", "4:currency"]);
  });

  it("rejects fractional counts and negative values", () => {
    const r = validateCsv([H, "2026-11-01,meta,A,USD,1,1.5,1,,,", "2026-11-02,meta,A,USD,-1,1,1,,,"].join("\n"), { today: TODAY });
    expect(r.errors.map((e) => e.column)).toEqual(["impressions", "spend"]);
  });

  it("rejects duplicate grain rows within a file", () => {
    const r = validateCsv([H, "2026-11-01,meta,A,USD,1,10,1,,,", "2026-11-01,Meta,A,USD,2,10,1,,,"].join("\n"), { today: TODAY });
    expect(r.ok).toBe(false);
    expect(r.errors[0]!.message).toMatch(/Duplicate of row 1/);
  });

  it("keeps empty cells as null (not available), zero as zero", () => {
    const r = validateCsv([H, "2026-11-01,meta,A,USD,0,100,,,,"].join("\n"), { today: TODAY });
    expect(r.ok).toBe(true);
    expect(r.rows[0]!.spend).toBe(0);
    expect(r.rows[0]!.clicks).toBeNull();
    expect(r.rows[0]!.leads).toBeNull();
  });

  it("warns (not fails) on clicks > impressions, unknown columns and multiple currencies", () => {
    const r = validateCsv(
      ["date,source,campaign_name,currency,spend,impressions,clicks,foo", "2026-11-01,a,A,USD,1,1,5,x", "2026-11-01,b,B,EUR,1,10,5,y"].join("\n"),
      { today: TODAY },
    );
    expect(r.ok).toBe(true);
    expect(r.warnings.map((w) => w.message).join(" ")).toMatch(/Ignored unknown column.*foo/);
    expect(r.warnings.some((w) => /Clicks are higher/.test(w.message))).toBe(true);
    expect(r.warnings.some((w) => /several currencies/.test(w.message))).toBe(true);
  });

  it("enforces size, binary and row limits", () => {
    expect(validateCsv("", { today: TODAY }).ok).toBe(false);
    expect(validateCsv("a\u0000b", { today: TODAY }).errors[0]!.message).toMatch(/binary/);
    expect(validateCsv("x", { today: TODAY, byteSize: CSV_LIMITS.maxBytes + 1 }).errors[0]!.message).toMatch(/larger/);
    const many = [H, ...Array.from({ length: CSV_LIMITS.maxRows + 1 }, (_, i) => `2026-11-01,s,C${i},USD,1,1,1,,,`)].join("\n");
    expect(validateCsv(many, { today: TODAY }).errors[0]!.message).toMatch(/Too many rows/);
  });

  it("strips BOM, normalizes source slugs and defaults ids", () => {
    const r = validateCsv("﻿" + [H, "2026-11-01,Meta Ads,Spring Sale!,usd,1,10,1,,,"].join("\n"), { today: TODAY });
    expect(r.ok).toBe(true);
    expect(r.rows[0]).toMatchObject({ source: "meta_ads", campaign_id: "name:spring_sale", account_id: "default", currency: "USD" });
  });

  it("revenue defaults to attributed; billed must be explicit", () => {
    const r = validateCsv(
      ["date,source,campaign_name,currency,revenue,revenue_type", "2026-11-01,crm,A,USD,100,", "2026-11-02,crm,A,USD,50,billed"].join("\n"),
      { today: TODAY },
    );
    const n = normalizeCsvRows(r.rows, { syncRunId: "00000000-0000-0000-0000-000000000000", companyTimezone: "UTC", now: new Date() }).normalized;
    expect(n[0]!.attributed_revenue).toBe(100);
    expect(n[0]!.billed_revenue).toBeNull();
    expect(n[1]!.billed_revenue).toBe(50);
    expect(n[1]!.attributed_revenue).toBeNull();
  });

  it("slugify is stable", () => {
    expect(slugify("  Google Ads (Search) ")).toBe("google_ads_search");
  });
});
