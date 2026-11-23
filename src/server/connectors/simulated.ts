import { daysBetweenInclusive, enumerateDates, localDate } from "../../lib/dates";
import { type Connector, ConnectorError, type FetchContext, type FetchResult, type ProviderDailyRecord } from "./types";

// SIMULATED connectors: deterministic SAMPLE data with the same shape as the
// live adapters. Every row is written with is_simulated = true and the UI
// labels it "Sample data — not your real results". Used when the administrator
// has not configured Google OAuth/API access, for demos and for tests.
//
// Late-arrival behaviour is modelled: recent days are reported lower and
// "mature" over the finalization window, so re-syncs correct earlier numbers.

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function rand(seed: string): number {
  return (hash(seed) % 1_000_000) / 1_000_000;
}

function maturity(date: string, today: string, finalizationDays: number): number {
  const age = daysBetweenInclusive(date, today) - 1; // 1 = yesterday
  if (age >= finalizationDays) return 1;
  return 0.75 + (0.25 * Math.max(0, age)) / finalizationDays;
}

export interface SimulationFault {
  code: ConstructorParameters<typeof ConnectorError>[0];
  times: number;
}

export class SimulatedConnector implements Connector {
  readonly mode = "simulated" as const;
  readonly origin: "ga4" | "google_ads";
  readonly requiredScopes = [] as const;
  readonly finalizationDays: number;
  readonly lookbackDays: number;
  private faultsLeft: number;

  constructor(
    readonly providerId: "ga4" | "google_ads",
    private readonly fault?: SimulationFault,
  ) {
    this.origin = providerId;
    this.finalizationDays = providerId === "ga4" ? 3 : 14;
    this.lookbackDays = this.finalizationDays;
    this.faultsLeft = fault?.times ?? 0;
  }

  async fetchDaily(ctx: FetchContext): Promise<FetchResult> {
    if (this.fault && this.faultsLeft > 0) {
      this.faultsLeft--;
      throw new ConnectorError(this.fault.code, `simulated ${this.fault.code}`);
    }
    const today = localDate(ctx.now, ctx.companyTimezone);
    const records: ProviderDailyRecord[] = [];
    const campaigns =
      this.providerId === "google_ads"
        ? [
            { id: "1001", name: "Sample — Search Brand", scale: 1.0 },
            { id: "1002", name: "Sample — Search Services", scale: 2.2 },
            { id: "1003", name: "Sample — Performance Max", scale: 1.6 },
          ]
        : [
            { id: "(organic)", name: "(organic)", scale: 3.0 },
            { id: "1002", name: "Sample — Search Services", scale: 1.2 },
            { id: "(direct)", name: "(direct)", scale: 1.5 },
          ];
    for (const date of enumerateDates(ctx.window.from, ctx.window.to)) {
      if (date >= today) continue; // only complete days
      const m = maturity(date, today, this.finalizationDays);
      for (const c of campaigns) {
        const r = rand(`${ctx.companyId}|${this.providerId}|${c.id}|${date}`);
        const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
        const weekFactor = weekday === 0 || weekday === 6 ? 0.7 : 1;
        if (this.providerId === "google_ads") {
          const impressions = Math.round((800 + r * 1200) * c.scale * weekFactor);
          const clicks = Math.round(impressions * (0.03 + r * 0.04));
          const spend = Number((clicks * (1.2 + r * 2.3)).toFixed(2));
          const conversions = Number((clicks * (0.04 + r * 0.05) * m).toFixed(2));
          records.push({
            date,
            account_id: "000-000-0000",
            account_name: "Sample Ads account",
            campaign_id: c.id,
            campaign_name: c.name,
            currency: "USD",
            timezone: ctx.companyTimezone,
            metrics: {
              impressions,
              clicks,
              spend,
              sessions: null,
              conversions,
              conversion_type: "ad_platform_conversion",
              leads: null,
              attributed_revenue: Number((conversions * (60 + r * 90)).toFixed(2)),
              billed_revenue: null,
            },
            raw: { simulated: true, impressions, clicks, cost_micros: Math.round(spend * 1e6), conversions },
          });
        } else {
          const sessions = Math.round((120 + r * 260) * c.scale * weekFactor * m);
          const keyEvents = Math.round(sessions * (0.02 + r * 0.03));
          records.push({
            date,
            account_id: "000000000",
            account_name: "Sample GA4 property",
            campaign_id: c.id,
            campaign_name: c.name,
            currency: "USD",
            timezone: ctx.companyTimezone,
            metrics: {
              impressions: null,
              clicks: null,
              spend: null,
              sessions,
              conversions: keyEvents,
              conversion_type: "ga4_key_event",
              leads: null,
              attributed_revenue: Number((keyEvents * (40 + r * 60)).toFixed(2)),
              billed_revenue: null,
            },
            raw: { simulated: true, sessions, keyEvents },
          });
        }
      }
    }
    return { records, apiCalls: 0, complete: true, notes: ["Sample data generated locally; no provider API was called."] };
  }
}
