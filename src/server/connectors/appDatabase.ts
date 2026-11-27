import pg from "pg";
import { createHash, randomBytes } from "node:crypto";
import { addDays, zonedTimeToUtc } from "../../lib/dates";
import { channelOf, type FunnelStage, PAGE_VIEW } from "../../lib/funnel";
import { type Connector, ConnectorError, type FetchContext, type FetchResult, type ProviderDailyRecord } from "./types";

// "Your app's database" connector (Supabase).
// The customer's database gets a schema `marketing_intel` with views in a fixed
// shape (see docs/CONNECTORS.md → App database). The platform connects as its own
// login role `mi_reader`, which may only read that schema (read-only transactions,
// statement timeout). The role and its password come from a script the platform
// generates; the customer runs it in Supabase → SQL Editor.
// Only Supabase hosts are accepted (no arbitrary hosts → no SSRF into private networks).
//
// Two uses:
//  - fetchDaily: daily totals per event for the dashboard and the connector table
//    (no person-level rows are stored by the platform);
//  - loadFunnel: the Funnel page, computed live in the customer's database.

export const READER_ROLE = "mi_reader";
const SCHEMA = "marketing_intel";

export interface AppDbTarget {
  host: string;
  port: number;
  database: string;
  projectRef: string;
}

/**
 * Reads Supabase's "Connection string" (Connect → Session pooler or Transaction pooler),
 * e.g. postgresql://postgres.abcd…:[YOUR-PASSWORD]@aws-0-us-east-1.pooler.supabase.com:5432/postgres.
 * The password part is ignored: the platform uses its own read-only role.
 */
export function parseSupabaseConnection(raw: string): AppDbTarget | string {
  const s = raw.trim();
  let u: URL;
  try {
    u = new URL(s.replace(/\[YOUR-PASSWORD\]/gi, "x"));
  } catch {
    return "This does not look like a connection string. In Supabase click Connect and copy the Session pooler string.";
  }
  if (!/^postgres(ql)?:$/.test(u.protocol)) return "The connection string should start with postgresql://.";
  const host = u.hostname.toLowerCase();
  if (!/^[a-z0-9-]+\.pooler\.supabase\.com$/.test(host)) {
    return "Please use the pooler connection string (its address ends with pooler.supabase.com): Supabase → Connect → Session pooler.";
  }
  const user = decodeURIComponent(u.username);
  const ref = /^[a-z_]+\.([a-z0-9]{20})$/.exec(user)?.[1];
  if (!ref) return "The connection string has no project id (the user name should look like postgres.abcd…).";
  const port = Number(u.port || 5432);
  if (port !== 5432 && port !== 6543) return "Unexpected port; use the Session pooler string (port 5432).";
  const database = decodeURIComponent(u.pathname.replace(/^\//, "")) || "postgres";
  if (!/^[A-Za-z0-9_]{1,63}$/.test(database)) return "Unexpected database name.";
  return { host, port: 5432, database, projectRef: ref };
}

export function newReaderPassword(): string {
  return randomBytes(24).toString("base64url");
}

/** The script the customer runs once in Supabase → SQL Editor (creates the read-only role). */
export function readerScript(password: string): string {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(password)) throw new Error("bad password");
  return [
    "-- Marketing Intelligence: a login that can ONLY read the schema marketing_intel.",
    "-- Safe to run again (it resets the password). To cut access: drop role mi_reader;",
    "do $$ begin",
    `  if not exists (select 1 from pg_roles where rolname = '${READER_ROLE}') then`,
    `    create role ${READER_ROLE} login password '${password}';`,
    "  else",
    `    alter role ${READER_ROLE} with login password '${password}';`,
    "  end if;",
    "end $$;",
    `alter role ${READER_ROLE} set default_transaction_read_only = on;`,
    `alter role ${READER_ROLE} set statement_timeout = '20s';`,
    `alter role ${READER_ROLE} connection limit 3;`,
    `create schema if not exists ${SCHEMA};`,
    `grant usage on schema ${SCHEMA} to ${READER_ROLE};`,
    `grant select on all tables in schema ${SCHEMA} to ${READER_ROLE};`,
    `grant execute on all functions in schema ${SCHEMA} to ${READER_ROLE};`,
    `alter default privileges in schema ${SCHEMA} grant select on tables to ${READER_ROLE};`,
    "",
  ].join("\n");
}

export interface AppDbSecret {
  target: AppDbTarget;
  password: string;
}

export function encodeSecret(s: AppDbSecret): string {
  return JSON.stringify(s);
}
export function decodeSecret(raw: string): AppDbSecret {
  try {
    const s = JSON.parse(raw) as AppDbSecret;
    if (s?.target?.host && s.password) return s;
  } catch {
    /* fall through */
  }
  throw new ConnectorError("auth_expired", "app database: stored connection is unreadable; connect again");
}

export type ClientFactory = (secret: AppDbSecret) => pg.Client;

const defaultFactory: ClientFactory = (s) =>
  new pg.Client({
    host: s.target.host,
    port: s.target.port,
    database: s.target.database,
    user: `${READER_ROLE}.${s.target.projectRef}`,
    password: s.password,
    // Supabase's pooler presents its own certificate chain; the connection is encrypted.
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 10_000,
    statement_timeout: 20_000,
    query_timeout: 25_000,
    application_name: "marketing-intelligence",
  });

function mapPgError(err: unknown): ConnectorError {
  const e = err as { code?: string; message?: string };
  const msg = String(e.message ?? "");
  if (e.code === "28P01" || /password authentication failed|authentication failed/i.test(msg))
    return new ConnectorError("auth_expired", "app database: the platform's login was not accepted (run the script again)");
  if (e.code === "42501" || /permission denied/i.test(msg)) return new ConnectorError("permission_denied", "app database: no permission to read marketing_intel");
  if (e.code === "3F000" || e.code === "42P01" || /does not exist/i.test(msg))
    return new ConnectorError("invalid_request", "app database: the schema marketing_intel or one of its views is missing");
  if (e.code === "57014" || /timeout/i.test(msg)) return new ConnectorError("timeout", "app database: the query took too long");
  if (/ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|Tenant or user not found/i.test(msg))
    return new ConnectorError("unavailable", `app database: could not connect (${msg.slice(0, 80)})`);
  return new ConnectorError("invalid_request", `app database: ${msg.slice(0, 160)}`);
}

export async function withAppDb<T>(secret: AppDbSecret, fn: (c: pg.Client) => Promise<T>, factory: ClientFactory = defaultFactory): Promise<T> {
  const c = factory(secret);
  try {
    await c.connect();
    await c.query("begin read only");
    const out = await fn(c);
    await c.query("rollback");
    return out;
  } catch (err) {
    if (err instanceof ConnectorError) throw err;
    throw mapPgError(err);
  } finally {
    await c.end().catch(() => undefined);
  }
}

/** Checks the login and the views; returns the event names found (for choosing funnel stages). */
export async function checkAppDb(secret: AppDbSecret, factory?: ClientFactory): Promise<{ events: string[]; people: number }> {
  return withAppDb(
    secret,
    async (c) => {
      const missing = (
        await c.query<{ v: string }>(
          `select v from unnest(array['events','page_views','identities','people']) v
            where not exists (select 1 from information_schema.tables t where t.table_schema = $1 and t.table_name = v)`,
          [SCHEMA],
        )
      ).rows.map((r) => r.v);
      if (missing.length) throw new ConnectorError("invalid_request", `app database: marketing_intel is missing: ${missing.join(", ")}`);
      const events = (await c.query<{ event: string }>(`select event from ${SCHEMA}.events where event is not null group by event order by count(*) desc limit 200`)).rows.map((r) => r.event);
      const people = Number((await c.query<{ n: string }>(`select count(*) n from ${SCHEMA}.people`)).rows[0]?.n ?? 0);
      return { events, people };
    },
    factory,
  );
}

const SIGNUP_EVENTS = ["account_created", "signup", "sign_up"];
const PAID_EVENTS = ["purchase", "subscription_started"];

export class AppDatabaseConnector implements Connector {
  readonly providerId = "app_database" as const;
  readonly origin = "app_database" as const;
  readonly mode = "live" as const;
  readonly requiredScopes = [] as const;
  readonly finalizationDays = 1;
  readonly lookbackDays = 2;

  constructor(private readonly cfg: { factory?: ClientFactory } = {}) {}

  async fetchDaily(ctx: FetchContext): Promise<FetchResult> {
    if (!ctx.credentials) throw new ConnectorError("auth_expired", "app database: no stored connection");
    const secret = decodeSecret(ctx.credentials.refreshToken);
    const tz = ctx.companyTimezone;
    const from = zonedTimeToUtc(ctx.window.from, "00:00", tz).toISOString();
    const to = zonedTimeToUtc(addDays(ctx.window.to, 1), "00:00", tz).toISOString();
    const rows = await withAppDb(
      secret,
      async (c) =>
        (
          await c.query<{ date: string; event: string; n: string; amount: string | null; currency: string | null }>(
            `select to_char(at at time zone $3, 'YYYY-MM-DD') as date, event, count(*)::text as n,
                    sum(amount) filter (where coalesce(livemode, true))::text as amount, max(currency) as currency
               from ${SCHEMA}.events
              where at >= $1 and at < $2 and event is not null
              group by 1, 2
             union all
             select to_char(at at time zone $3, 'YYYY-MM-DD'), '${PAGE_VIEW}', count(*)::text, null, null
               from ${SCHEMA}.page_views where at >= $1 and at < $2 group by 1`,
            [from, to, tz],
          )
        ).rows,
      this.cfg.factory,
    );
    const nullMetrics = { impressions: null, clicks: null, spend: null, sessions: null, conversions: null, conversion_type: null, leads: null, attributed_revenue: null, billed_revenue: null };
    const byDay = new Map<string, { leads: number; paid: number; revenue: number; currency: string | null }>();
    const records: ProviderDailyRecord[] = [];
    for (const r of rows) {
      const n = Number(r.n);
      const amount = r.amount === null ? 0 : Number(r.amount);
      records.push({
        date: r.date,
        account_id: ctx.externalAccountId,
        account_name: null,
        campaign_id: "app",
        campaign_name: "App events",
        currency: null,
        timezone: tz,
        metrics: nullMetrics,
        raw: { date: r.date, event: r.event, count: n, amount: Math.round(amount * 100) / 100 },
        rawKey: `${r.date}\u001f${r.event}`,
        role: "table",
      });
      const d = byDay.get(r.date) ?? { leads: 0, paid: 0, revenue: 0, currency: null };
      if (SIGNUP_EVENTS.includes(r.event)) d.leads += n;
      if (PAID_EVENTS.includes(r.event)) {
        d.paid += r.event === "purchase" ? n : 0;
        d.revenue += r.event === "purchase" ? amount : 0;
        d.currency = d.currency ?? r.currency;
      }
      byDay.set(r.date, d);
    }
    for (const [date, d] of byDay) {
      records.push({
        date,
        account_id: ctx.externalAccountId,
        account_name: null,
        campaign_id: "app",
        campaign_name: "App events",
        currency: d.revenue ? (d.currency ?? "USD") : null,
        timezone: tz,
        // Sign-ups are leads; purchases are the app's own conversions. Revenue is not added
        // here (Stripe already reports the money; adding it twice would double it).
        metrics: { ...nullMetrics, leads: d.leads, conversions: d.paid, conversion_type: "csv_conversion" },
        raw: {},
        role: "dashboard",
      });
    }
    return { records, apiCalls: 1, complete: true, notes: [] };
  }
}

// ---------------------------------------------------------------------------
// Funnel (computed live in the customer's database; nothing person-level is stored)
// ---------------------------------------------------------------------------

export interface FunnelPerson {
  key: string;
  channel: string;
  source: string | null;
  firstSeen: string;
  reached: (string | null)[];
  revenue: number;
}

export interface FunnelResult {
  stages: string[];
  totals: number[];
  byChannel: { channel: string; counts: number[]; revenue: number }[];
  bySource: { source: string; channel: string; counts: number[]; revenue: number }[];
  people: FunnelPerson[];
  currency: string | null;
  medianDaysToLast: number | null;
}

/**
 * People whose first touch falls in [from, to] (company days), with the first time they
 * reached each stage. Devices are merged into people through marketing_intel.identities.
 */
export async function loadFunnel(
  secret: AppDbSecret,
  args: { from: string; to: string; timezone: string; stages: FunnelStage[]; excludeTesters: boolean; ownHost?: string | null },
  factory?: ClientFactory,
): Promise<FunnelResult> {
  const stageMap = args.stages.flatMap((s, i) => s.events.map((event) => ({ ord: i, event })));
  const from = zonedTimeToUtc(args.from, "00:00", args.timezone).toISOString();
  const to = zonedTimeToUtc(addDays(args.to, 1), "00:00", args.timezone).toISOString();
  const own = (args.ownHost ?? "").toLowerCase().replace(/^www\./, "");
  const rows = await withAppDb(
    secret,
    async (c) =>
      (
        await c.query<{ who: string; first_at: Date; ref_host: string | null; src: string | null; hits: Record<string, string> | null; revenue: string | null; currency: string | null }>(
          `with idmap as (select device_id, min(person_id::text) as person_id from ${SCHEMA}.identities group by device_id),
           touch as (
             select coalesce(e.person_id::text, i.person_id, 'd:' || e.device_id) as who, e.at, e.event, e.ref_host, e.src,
                    case when e.event = 'purchase' and coalesce(e.livemode, true) then e.amount end as amount, e.currency
               from ${SCHEMA}.events e left join idmap i on i.device_id = e.device_id
              where e.person_id is not null or e.device_id is not null
             union all
             select coalesce(p.person_id::text, i.person_id, 'd:' || p.device_id), p.at, '${PAGE_VIEW}', p.ref_host, null, null, null
               from ${SCHEMA}.page_views p left join idmap i on i.device_id = p.device_id
              where p.person_id is not null or p.device_id is not null
           ),
           testers as (select person_id::text as pid from ${SCHEMA}.people where $4 and is_tester),
           cohort as (
             select who, min(at) as first_at from touch group by who
             having min(at) >= $1 and min(at) < $2 and who not in (select pid from testers)
           ),
           stage_map as (select (x->>'ord')::int as ord, x->>'event' as event from jsonb_array_elements($3::jsonb) x),
           hits as (
             select h.who, jsonb_object_agg(h.ord::text, h.at) as hits
               from (select t.who, m.ord, min(t.at) as at from touch t join stage_map m on m.event = t.event join cohort using (who) group by 1, 2) h
              group by h.who
           ),
           money as (select t.who, sum(t.amount) as revenue, max(t.currency) as currency from touch t join cohort using (who) where t.amount is not null group by t.who),
           src as (
             select distinct on (t.who) t.who, t.ref_host, t.src from touch t join cohort using (who)
              where (t.ref_host is not null and t.ref_host not in ('direct', 'checkout.stripe.com', 'billing.stripe.com', $5)) or t.src is not null
              order by t.who, t.at
           )
           select c.who, c.first_at, s.ref_host, s.src, h.hits, m.revenue::text as revenue, m.currency
             from cohort c left join src s using (who) left join hits h using (who) left join money m using (who)`,
          [from, to, JSON.stringify(stageMap), args.excludeTesters, own || "-"],
        )
      ).rows,
    factory,
  );

  const n = args.stages.length;
  const totals = new Array<number>(n).fill(0);
  const channels = new Map<string, { counts: number[]; revenue: number }>();
  const sources = new Map<string, { channel: string; counts: number[]; revenue: number }>();
  const people: FunnelPerson[] = [];
  const days: number[] = [];
  let currency: string | null = null;
  for (const r of rows) {
    const reached = Array.from({ length: n }, (_, i) => (r.hits?.[String(i)] ? new Date(r.hits[String(i)]!).toISOString() : null));
    // A stage counts only if every earlier stage was reached too (a funnel never grows).
    let ok = true;
    const passed = reached.map((d) => (ok = ok && d !== null));
    const host = r.ref_host && r.ref_host !== own ? r.ref_host : null;
    const channel = channelOf(host, r.src);
    const sourceKey = host ?? "(direct / unknown)";
    const revenue = Number(r.revenue) || 0;
    currency = currency ?? r.currency;
    const ch = channels.get(channel) ?? { counts: new Array<number>(n).fill(0), revenue: 0 };
    const so = sources.get(sourceKey) ?? { channel, counts: new Array<number>(n).fill(0), revenue: 0 };
    passed.forEach((p, i) => {
      if (p) {
        totals[i]!++;
        ch.counts[i]!++;
        so.counts[i]!++;
      }
    });
    ch.revenue += revenue;
    so.revenue += revenue;
    channels.set(channel, ch);
    sources.set(sourceKey, so);
    const last = reached[n - 1];
    if (passed[n - 1] && last) days.push((Date.parse(last) - new Date(r.first_at).getTime()) / 86_400_000);
    people.push({
      key: anonKey(r.who),
      channel,
      source: r.src ? `${sourceKey} · ${r.src}` : sourceKey,
      firstSeen: new Date(r.first_at).toISOString(),
      reached: reached.map((d, i) => (passed[i] ? d : null)),
      revenue,
    });
  }
  days.sort((a, b) => a - b);
  const sortRows = <T extends { counts: number[]; revenue: number }>(a: T, b: T) =>
    b.revenue - a.revenue || b.counts[n - 1]! - a.counts[n - 1]! || b.counts[0]! - a.counts[0]!;
  return {
    stages: args.stages.map((s) => s.label),
    totals,
    byChannel: [...channels.entries()].map(([channel, v]) => ({ channel, ...v })).sort(sortRows),
    bySource: [...sources.entries()].map(([source, v]) => ({ source, ...v })).sort(sortRows).slice(0, 30),
    people: people
      .sort((a, b) => furthest(b) - furthest(a) || b.revenue - a.revenue || b.firstSeen.localeCompare(a.firstSeen))
      .slice(0, 200),
    currency,
    medianDaysToLast: days.length ? Math.round(days[Math.floor(days.length / 2)]! * 10) / 10 : null,
  };
}

function furthest(p: FunnelPerson): number {
  let i = 0;
  while (i < p.reached.length && p.reached[i]) i++;
  return i;
}

/** A short, stable, non-reversible label instead of the app's user id or device id. */
function anonKey(who: string): string {
  return (who.startsWith("d:") ? "visitor-" : "user-") + createHash("sha256").update(who).digest("hex").slice(0, 8);
}

/** Event names to offer when choosing stages (cheap: one grouped query). */
export async function listAppEvents(secret: AppDbSecret, factory?: ClientFactory): Promise<string[]> {
  return (await checkAppDb(secret, factory)).events;
}
