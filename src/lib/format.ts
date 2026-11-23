import type { KpiValue } from "./kpi";

export function fmtInt(n: number | null | undefined): string {
  return n === null || n === undefined ? "—" : Math.round(n).toLocaleString("en-US");
}

export function fmtMoney(n: number | null | undefined, currency: string | null | undefined): string {
  if (n === null || n === undefined) return "—";
  if (!currency || !/^[A-Z]{3}$/.test(currency)) return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
  try {
    return n.toLocaleString("en-US", { style: "currency", currency, maximumFractionDigits: 2 });
  } catch {
    return `${n.toFixed(2)} ${currency}`;
  }
}

export function fmtNumber(n: number | null | undefined, digits = 2): string {
  return n === null || n === undefined ? "—" : n.toLocaleString("en-US", { maximumFractionDigits: digits });
}

export function kpiText(k: KpiValue, kind: "percent" | "money" | "ratio", currency?: string | null): string {
  if (k.status === "ok" && k.value !== null) {
    if (kind === "percent") return `${k.value.toFixed(2)}%`;
    if (kind === "money") return fmtMoney(k.value, currency);
    return `${k.value.toFixed(2)}×`;
  }
  return "Not available";
}

export function kpiReason(k: KpiValue): string | undefined {
  switch (k.status) {
    case "not_available":
      return "This source does not provide the data needed for this metric.";
    case "zero_denominator":
      return "Cannot be calculated: the denominator is zero for this period.";
    case "mixed_currency":
      return "Cannot be calculated across different currencies (no conversion is applied).";
    default:
      return undefined;
  }
}

export function fmtDelta(pct: number | null): { text: string; tone: "up" | "down" | "flat" | "none" } {
  if (pct === null) return { text: "no comparison", tone: "none" };
  if (Math.abs(pct) < 0.05) return { text: "0%", tone: "flat" };
  return { text: `${pct > 0 ? "+" : ""}${pct.toFixed(1)}%`, tone: pct > 0 ? "up" : "down" };
}

export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return "never";
  return new Date(iso).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
}
