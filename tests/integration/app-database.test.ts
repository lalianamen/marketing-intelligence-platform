import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import pg from "pg";
import { AppDatabaseConnector, type AppDbSecret, checkAppDb, encodeSecret, loadFunnel, readerScript } from "@/server/connectors/appDatabase";
import { normalizeProviderRecords } from "@/server/ingestion/normalize";
import { suggestStages } from "@/lib/funnel";
import { cfg, pool } from "./helpers";

// A customer's database in miniature: the views of marketing_intel over its own tables,
// and the platform's read-only login made by the generated script.
const PASSWORD = "Test_reader_password_123";
const secret: AppDbSecret = { target: { host: "aws-0-x.pooler.supabase.com", port: 5432, database: "postgres", projectRef: "abcdefghijklmnopqrst" }, password: PASSWORD };
const local = new URL(cfg.databaseUrl);
const factory = () =>
  new pg.Client({ host: local.hostname, port: Number(local.port), database: "postgres", user: "mi_reader", password: PASSWORD, statement_timeout: 20_000 });

beforeAll(async () => {
  await pool.query(`
    drop schema if exists mi_test_app cascade; drop schema if exists marketing_intel cascade;
    create schema mi_test_app;
    create table mi_test_app.app_events (id bigint primary key, at timestamptz, device text, user_id uuid, name text, meta jsonb);
    create table mi_test_app.page_views (id bigint primary key, at timestamptz, device text, user_id uuid, path text, ref text);
    create table mi_test_app.profiles (id uuid primary key, name text, email text, created_at timestamptz, is_tester boolean);
    create schema marketing_intel;
    create view marketing_intel.events as
      select id, at, device as device_id, user_id as person_id, name as event, meta->>'src' as src, meta->>'ref' as ref_host,
             (meta->>'amount_paid')::numeric / 100 as amount, upper(meta->>'currency') as currency, (meta->>'livemode')::boolean as livemode
        from mi_test_app.app_events;
    create view marketing_intel.page_views as select id, at, device as device_id, user_id as person_id, path, ref as ref_host from mi_test_app.page_views;
    create view marketing_intel.identities as
      select distinct device as device_id, user_id as person_id from mi_test_app.app_events where device is not null and user_id is not null;
    create view marketing_intel.people as select id as person_id, created_at as signed_up_at, coalesce(is_tester, false) as is_tester from mi_test_app.profiles;
  `);
  // Ann: came from Google, tested, signed up, paid $19.99. Bob: from Bing, only looked. Tess: a tester who paid.
  await pool.query(`
    insert into mi_test_app.profiles values
      ('00000000-0000-0000-0000-00000000000a', 'Ann', 'ann@example.test', '2026-11-02T18:00:00Z', false),
      ('00000000-0000-0000-0000-00000000000c', 'Tess', 'tess@example.test', '2026-11-02T18:00:00Z', true);
    insert into mi_test_app.page_views values
      (1, '2026-11-02T17:00:00Z', 'dev-ann', null, '/practice', 'google.com'),
      (2, '2026-11-03T17:00:00Z', 'dev-bob', null, '/', 'bing.com'),
      (3, '2026-11-02T17:00:00Z', 'dev-tess', null, '/', 'google.com');
    insert into mi_test_app.app_events values
      (1, '2026-11-02T17:05:00Z', 'dev-ann', null, 'sample_started', '{"ref":"google.com"}'),
      (2, '2026-11-02T18:00:00Z', 'dev-ann', '00000000-0000-0000-0000-00000000000a', 'account_created', '{}'),
      (3, '2026-11-04T18:00:00Z', 'dev-ann', '00000000-0000-0000-0000-00000000000a', 'purchase', '{"amount_paid":1999,"currency":"usd","livemode":true}'),
      (4, '2026-11-02T18:00:00Z', 'dev-tess', '00000000-0000-0000-0000-00000000000c', 'purchase', '{"amount_paid":999,"currency":"usd","livemode":true}');
  `);
  await pool.query(readerScript(PASSWORD));
});
afterAll(async () => {
  await pool.query(`drop schema if exists marketing_intel cascade; drop schema if exists mi_test_app cascade; drop role if exists mi_reader;`);
  await pool.end();
});

describe("Your app's database (marketing_intel, read-only login)", () => {
  it("the generated login reads marketing_intel only, and only reads", async () => {
    const c = factory();
    await c.connect();
    await expect(c.query(`select * from mi_test_app.profiles`)).rejects.toThrow(/permission denied/);
    await expect(c.query(`create table marketing_intel.x (id int)`)).rejects.toThrow(/read-only|permission denied/);
    expect((await c.query(`select count(*)::int n from marketing_intel.events`)).rows[0].n).toBe(4);
    await c.end();
    const found = await checkAppDb(secret, factory);
    expect(found.events).toEqual(expect.arrayContaining(["purchase", "account_created", "sample_started"]));
    expect(suggestStages(found.events).map((s) => s.label)).toEqual(["Visited", "Free test", "Signed up", "Paid"]);
  });

  it("funnel: devices merge into people, first source wins, testers are left out, revenue per channel", async () => {
    const stages = suggestStages(["sample_started", "account_created", "purchase"]);
    const f = await loadFunnel(secret, { from: "2026-11-01", to: "2026-11-30", timezone: "America/Los_Angeles", stages, excludeTesters: true, ownHost: "licena.us" }, factory);
    expect(f.totals).toEqual([2, 1, 1, 1]);
    expect(f.byChannel.map((c) => [c.channel, c.counts, c.revenue])).toEqual([
      ["Search", [2, 1, 1, 1], 19.99],
    ]);
    expect(f.bySource.map((s) => [s.source, s.counts[0]])).toEqual([["google.com", 1], ["bing.com", 1]]);
    expect(f.people[0]).toMatchObject({ channel: "Search", source: "google.com", revenue: 19.99 });
    expect(f.people[0]!.key).toMatch(/^user-[0-9a-f]{8}$/); // no ids or emails reach the page
    expect(f.medianDaysToLast).toBe(2);
    const withTesters = await loadFunnel(secret, { from: "2026-11-01", to: "2026-11-30", timezone: "UTC", stages, excludeTesters: false }, factory);
    expect(withTesters.totals[0]).toBe(3);
  });

  it("daily totals: one table row per event and day; the dashboard gets sign-ups as leads and purchases as conversions", async () => {
    const out = await new AppDatabaseConnector({ factory }).fetchDaily({
      window: { from: "2026-11-01", to: "2026-11-05" }, externalAccountId: "abcdefghijklmnopqrst", companyId: "c", companyTimezone: "UTC",
      credentials: { refreshToken: encodeSecret(secret) }, now: new Date("2026-11-27T00:00:00Z"),
    });
    const n = normalizeProviderRecords(out.records, { syncRunId: "r", origin: "app_database", isSimulated: false, today: "2026-11-27", finalizationDays: 1, now: new Date() });
    // Nov 2: Ann signed up (Tess has no sign-up event) and Tess paid; Nov 4: Ann paid. Money stays with Stripe.
    expect(n.normalized.map((r) => [r.metric_date, r.leads, r.conversions, r.attributed_revenue]).sort()).toEqual([
      ["2026-11-02", 1, 1, null],
      ["2026-11-03", 0, 0, null],
      ["2026-11-04", 0, 1, null],
    ]);
    expect(out.records.filter((r) => r.role === "table").map((r) => r.raw)).toEqual(expect.arrayContaining([
      { date: "2026-11-04", event: "purchase", count: 1, amount: 19.99 },
      { date: "2026-11-02", event: "page_view", count: 2, amount: 0 },
    ]));
  });
});
