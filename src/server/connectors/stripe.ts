import { type FetchLike } from "./google";
import { columnCatalog } from "../../lib/columnCatalog";
import { addDays, zonedTimeToUtc } from "../../lib/dates";
import { type Connector, ConnectorError, connectorErrorFromHttp, type FetchContext, type FetchResult, type ProviderDailyRecord } from "./types";

// Stripe LIVE connector — balance transactions (GET /v1/balance_transactions).
// Auth: a restricted, read-only API key the user creates in Stripe (rk_live_… /
// rk_test_…), stored encrypted. Full secret keys (sk_…) are refused: the platform
// never needs to change anything in Stripe.
// Days are the company's time zone. Amounts are converted from the smallest unit
// (cents) to normal units. Dashboard: billed revenue = charges − refunds − lost
// disputes (+ won-back disputes); payouts, fees and transfers are not revenue.

const API = "https://api.stripe.com/v1";
const PAGE = 100;
const MAX_PAGES = 2000;
const ZERO_DECIMAL = new Set(["bif", "clp", "djf", "gnf", "jpy", "kmf", "krw", "mga", "pyg", "rwf", "ugx", "vnd", "vuv", "xaf", "xof", "xpf"]);
const THREE_DECIMAL = new Set(["bhd", "jod", "kwd", "omr", "tnd"]);
const REVENUE_CATEGORIES = new Set(["charge", "refund", "dispute", "dispute_reversal", "partial_capture_reversal"]);

export function stripeUnits(minor: number, currency: string): number {
  const c = currency.toLowerCase();
  const d = ZERO_DECIMAL.has(c) ? 1 : THREE_DECIMAL.has(c) ? 1000 : 100;
  return Math.round(minor) / d;
}

export function stripeKeyProblem(key: string): string | null {
  if (/^sk_(live|test)_/.test(key)) return "This is a full secret key. Please create a restricted key with read-only access instead (it starts with rk_).";
  if (!/^rk_(live|test)_[A-Za-z0-9]{10,250}$/.test(key)) return "This does not look like a Stripe restricted key (it starts with rk_live_ or rk_test_).";
  return null;
}

async function get(f: FetchLike, key: string, path: string, params: Record<string, string>): Promise<unknown> {
  const url = new URL(`${API}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  let res: Response;
  try {
    res = await f(url.toString(), { headers: { authorization: `Bearer ${key}`, "stripe-version": "2024-06-20" }, signal: AbortSignal.timeout(30_000) });
  } catch (err) {
    throw new ConnectorError("timeout", `stripe: ${(err as Error).name}`);
  }
  const body = await res.text();
  if (res.status === 401) throw new ConnectorError("auth_expired", "stripe: the key is invalid or was deleted");
  if (res.status === 403) throw new ConnectorError("permission_denied", "stripe: the key may not read balance transactions (give it Balance → Read)");
  if (!res.ok) throw connectorErrorFromHttp(res.status, body, "stripe");
  return JSON.parse(body);
}

/** Checks the key with one small request; returns whether it is a test-mode key. */
export async function checkStripeKey(f: FetchLike, key: string): Promise<{ testMode: boolean }> {
  await get(f, key, "/balance_transactions", { limit: "1" });
  return { testMode: key.startsWith("rk_test_") };
}

interface Txn {
  id: string;
  amount: number;
  fee: number;
  net: number;
  currency: string;
  created: number;
  type: string;
  reporting_category?: string;
  status?: string;
  description?: string | null;
}

export class StripeConnector implements Connector {
  readonly providerId = "stripe" as const;
  readonly origin = "stripe" as const;
  readonly mode = "live" as const;
  readonly requiredScopes = [] as const;
  readonly finalizationDays = 3;
  readonly lookbackDays = 3;

  constructor(private readonly cfg: { fetch?: FetchLike } = {}) {}

  async fetchDaily(ctx: FetchContext): Promise<FetchResult> {
    if (!ctx.credentials) throw new ConnectorError("auth_expired", "stripe: connection has no stored key");
    const f = this.cfg.fetch ?? fetch;
    const key = ctx.credentials.refreshToken;
    const tz = ctx.companyTimezone;
    const from = Math.floor(zonedTimeToUtc(ctx.window.from, "00:00", tz).getTime() / 1000);
    const to = Math.floor(zonedTimeToUtc(addDays(ctx.window.to, 1), "00:00", tz).getTime() / 1000);
    const dayOf = (unix: number) => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(unix * 1000));

    const txns: Txn[] = [];
    let after = "";
    let apiCalls = 0;
    let complete = false;
    for (let page = 0; page < MAX_PAGES; page++) {
      const json = (await get(f, key, "/balance_transactions", {
        limit: String(PAGE),
        "created[gte]": String(from),
        "created[lt]": String(to),
        ...(after ? { starting_after: after } : {}),
      })) as { data?: Txn[]; has_more?: boolean };
      apiCalls++;
      const data = json.data ?? [];
      txns.push(...data);
      if (!json.has_more || data.length === 0) {
        complete = true;
        break;
      }
      after = data[data.length - 1]!.id;
    }

    const fields = columnCatalog("stripe")!.fields(ctx.options?.columns);
    const dims = fields.dimensions;
    const rows = new Map<string, Record<string, string | number>>();
    const dash = new Map<string, { date: string; currency: string; revenue: number }>();
    for (const t of txns) {
      const date = dayOf(t.created);
      const currency = (t.currency ?? "").toLowerCase();
      const values: Record<string, string> = {
        date,
        currency,
        reporting_category: t.reporting_category ?? "",
        type: t.type ?? "",
        status: t.status ?? "",
        id: t.id,
        description: (t.description ?? "").slice(0, 300),
      };
      const k = dims.map((d) => values[d] ?? "").join("\u001f");
      const row = rows.get(k) ?? Object.fromEntries([...dims.map((d) => [d, values[d] ?? ""]), ["transactions", 0], ["amount", 0], ["fee", 0], ["net", 0]]);
      row.transactions = Number(row.transactions) + 1;
      row.amount = Number(row.amount) + stripeUnits(t.amount, currency);
      row.fee = Number(row.fee) + stripeUnits(t.fee, currency);
      row.net = Number(row.net) + stripeUnits(t.net, currency);
      rows.set(k, row);
      if (REVENUE_CATEGORIES.has(t.reporting_category ?? t.type)) {
        const dk = `${date}|${currency}`;
        const d = dash.get(dk) ?? { date, currency, revenue: 0 };
        d.revenue += stripeUnits(t.amount, currency);
        dash.set(dk, d);
      }
    }

    const base = (date: string, currency: string) => ({
      date,
      account_id: ctx.externalAccountId,
      account_name: null,
      campaign_id: `stripe:${currency}`,
      campaign_name: `Stripe (${currency.toUpperCase()})`,
      currency: currency.toUpperCase(),
      timezone: tz,
    });
    const nullMetrics = { impressions: null, clicks: null, spend: null, sessions: null, conversions: null, conversion_type: null, leads: null, attributed_revenue: null, billed_revenue: null };
    const records: ProviderDailyRecord[] = [];
    for (const d of dash.values()) {
      records.push({ ...base(d.date, d.currency), metrics: { ...nullMetrics, billed_revenue: Math.round(d.revenue * 100) / 100 }, raw: {}, role: "dashboard" });
    }
    for (const row of rows.values()) {
      for (const m of ["amount", "fee", "net"]) row[m] = Math.round(Number(row[m]) * 1000) / 1000;
      records.push({ ...base(String(row.date), String(row.currency)), metrics: nullMetrics, raw: row, rawKey: dims.map((d) => String(row[d] ?? "")).join("\u001f"), role: "table" });
    }
    const notes = complete ? [] : [`Stopped after ${MAX_PAGES * PAGE} transactions; load a shorter period.`];
    return { records, apiCalls, complete, notes };
  }
}
