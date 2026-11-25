import { describe, expect, it, vi } from "vitest";
import { StripeConnector, stripeKeyProblem, stripeUnits } from "@/server/connectors/stripe";
import { normalizeProviderRecords } from "@/server/ingestion/normalize";
import { rawColumnsFor } from "@/lib/rawTable";

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
// 2026-11-01 00:30 in Los Angeles = 07:30 UTC; 2026-11-01 23:30 LA = 2026-11-02 07:30 UTC.
const t = (id: string, iso: string, amount: number, fee: number, type: string, category: string, currency = "usd") => ({
  id, amount, fee, net: amount - fee, currency, created: Date.parse(iso) / 1000, type, reporting_category: category, status: "available", description: null,
});

describe("Stripe connector", () => {
  it("reads every page of the window in the company's days; amounts in dollars; dashboard = payments minus refunds", async () => {
    const f = vi.fn()
      .mockResolvedValueOnce(json({ has_more: true, data: [
        t("txn_1", "2026-11-02T07:30:00Z", 10000, 320, "charge", "charge"), // 23:30 on Nov 1 in LA
        t("txn_2", "2026-11-01T08:00:00Z", 5000, 175, "charge", "charge"),
      ] }))
      .mockResolvedValueOnce(json({ has_more: false, data: [
        t("txn_3", "2026-11-01T20:00:00Z", -2000, 0, "refund", "refund"),
        t("txn_4", "2026-11-01T21:00:00Z", -12000, 0, "payout", "payout"),
      ] }));
    const c = new StripeConnector({ fetch: f });
    const out = await c.fetchDaily({
      window: { from: "2026-11-01", to: "2026-11-01" }, externalAccountId: "key-x", companyId: "c", companyTimezone: "America/Los_Angeles",
      credentials: { refreshToken: ["rk", "live", "xxxxxxxxxxxxxxxx"].join("_") }, now: new Date("2026-11-25T00:00:00Z"), options: { columns: ["reporting_category"] },
    });
    const first = new URL(String(f.mock.calls[0]![0]));
    expect(first.searchParams.get("created[gte]")).toBe(String(Date.parse("2026-11-01T07:00:00Z") / 1000)); // LA midnight
    expect(first.searchParams.get("created[lt]")).toBe(String(Date.parse("2026-11-02T08:00:00Z") / 1000)); // DST ends Nov 1
    expect(new URL(String(f.mock.calls[1]![0])).searchParams.get("starting_after")).toBe("txn_2");

    const n = normalizeProviderRecords(out.records, { syncRunId: "r", origin: "stripe", isSimulated: false, today: "2026-11-25", finalizationDays: 3, now: new Date() });
    expect(n.normalized.map((r) => [r.metric_date, r.currency, r.billed_revenue])).toEqual([["2026-11-01", "USD", 130]]); // 100 + 50 − 20; payout is not revenue
    const rows = n.raw.map((r) => JSON.parse(r.payload_json));
    expect(rows).toEqual(expect.arrayContaining([
      { date: "2026-11-01", currency: "usd", reporting_category: "charge", transactions: 2, amount: 150, fee: 4.95, net: 145.05 },
      { date: "2026-11-01", currency: "usd", reporting_category: "payout", transactions: 1, amount: -120, fee: 0, net: -120 },
    ]));
    expect(rawColumnsFor("stripe", [], ["reporting_category"]).map((c) => c.label)).toEqual(["currency", "reporting_category", "transactions", "amount", "fee", "net"]);
  });

  it("only read-only restricted keys are accepted; amounts respect zero-decimal currencies", () => {
    expect(stripeKeyProblem(["sk", "live", "xxxxxxxxxxxxxxxxxxxx"].join("_"))).toMatch(/full secret key/);
    expect(stripeKeyProblem("pk_live_abc")).toMatch(/does not look like/);
    expect(stripeKeyProblem(["rk", "live", "xxxxxxxxxxxxxxxx"].join("_"))).toBeNull();
    expect(stripeUnits(1999, "usd")).toBe(19.99);
    expect(stripeUnits(1999, "jpy")).toBe(1999);
    expect(stripeUnits(1999, "kwd")).toBe(1.999);
  });
});
