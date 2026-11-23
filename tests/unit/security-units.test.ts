import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret, redact } from "@/server/crypto";
import { assertSafeIdentifier, datasetIdForCompany, isSafeIdentifier } from "@/server/warehouse/datasetId";
import { buildReportCsv, escapeCell } from "@/server/reporting/csvExport";

describe("dataset ids", () => {
  it("are deterministic, BigQuery-safe and environment-prefixed", () => {
    const id = datasetIdForCompany("mip_dev", "3F2504E0-4F89-11D3-9A0C-0305E82C3301");
    expect(id).toBe("mip_dev_c_3f2504e04f8911d39a0c0305e82c3301");
    expect(isSafeIdentifier(id)).toBe(true);
    expect(datasetIdForCompany("mip_dev", "3f2504e0-4f89-11d3-9a0c-0305e82c3301")).toBe(id);
  });
  it("reject forged / injected inputs", () => {
    expect(() => datasetIdForCompany("mip_dev", "x; drop table")).toThrow();
    expect(() => datasetIdForCompany("Bad-Prefix", "3f2504e0-4f89-11d3-9a0c-0305e82c3301")).toThrow();
    expect(() => assertSafeIdentifier("a`b")).toThrow();
    expect(() => assertSafeIdentifier("other.dataset")).toThrow();
  });
});

describe("secret encryption", () => {
  const key = randomBytes(32).toString("base64");
  it("round-trips and binds to AAD (connection id)", () => {
    const env = encryptSecret("1//refresh-token-value", key, "conn-a");
    expect(env).not.toContain("refresh-token-value");
    expect(decryptSecret(env, key, "conn-a")).toBe("1//refresh-token-value");
    expect(() => decryptSecret(env, key, "conn-b")).toThrow();
    expect(() => decryptSecret(env, randomBytes(32).toString("base64"), "conn-a")).toThrow();
  });
  it("rejects short keys", () => {
    expect(() => encryptSecret("x", Buffer.from("short").toString("base64"))).toThrow();
  });
  it("redacts tokens from log messages", () => {
    // secret-scan:allow-fixture (synthetic token-shaped strings)
    const m = redact('failed: Bearer ya29.abcDEF123 {"refresh_token":"1//0gXYZ"} eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.c2lnbmF0dXJlLXZhbHVl');
    expect(m).not.toMatch(/ya29|1\/\/0g|eyJhbGci/);
  });
});

describe("CSV export", () => {
  it("neutralizes spreadsheet formula injection in text cells", () => {
    expect(escapeCell("=HYPERLINK(\"http://x\")")).toBe(`"'=HYPERLINK(""http://x"")"`);
    expect(escapeCell("+1")).toBe("'+1");
    expect(escapeCell("@SUM(A1)")).toBe("'@SUM(A1)");
    expect(escapeCell("-cmd")).toBe("'-cmd");
    expect(escapeCell(-5)).toBe("-5"); // real numbers are untouched
    expect(escapeCell(null)).toBe("");
    expect(escapeCell("a,b")).toBe('"a,b"');
  });
  it("builds an Excel-compatible report with provenance and BOM", () => {
    const csv = buildReportCsv({
      companyName: "=Evil Co",
      range: { from: "2026-11-01", to: "2026-11-02" },
      daily: [
        {
          metric_date: "2026-11-01", origin: "csv", source: "meta_ads", currency: "USD", is_simulated: false,
          impressions: 10, clicks: 1, spend: 2.5, sessions: null, conversions: null, conversion_type: null, leads: null,
          attributed_revenue: null, billed_revenue: null, campaign_count: 1, has_preliminary: false,
        },
      ],
      campaigns: [],
      generatedAt: new Date("2026-11-23T00:00:00Z"),
      simulatedWarehouse: true,
    });
    expect(csv.startsWith("﻿")).toBe(true);
    expect(csv).toContain("company,'=Evil Co");
    expect(csv).toContain("LOCAL SIMULATED WAREHOUSE");
    expect(csv).toContain("daily,2026-11-01,csv,meta_ads,USD,false,final,10,1,2.5,,,,,,,1");
    expect(csv).toContain("\r\n");
  });
});
