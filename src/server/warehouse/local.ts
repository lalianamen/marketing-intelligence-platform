import pg from "pg";
import type { CampaignRow, MartRow, NormalizedRow, RawRecord } from "../../lib/model";
import { assertSafeIdentifier } from "./datasetId";
import {
  assertRawPath,
  type RawPageQuery,
  type RawPath,
  CURRENT_SCHEMA_VERSION,
  type DatasetLabels,
  type DatasetRef,
  type DateRange,
  type QueryStats,
  type Warehouse,
  WarehouseError,
} from "./types";

// LOCAL SIMULATED WAREHOUSE.
// Mirrors the BigQuery layout (one isolated "dataset" per company, RAW /
// NORMALIZED / MART layers) using one PostgreSQL schema per dataset in a
// separate database. It stores real uploaded data, but it is NOT BigQuery: the
// UI labels resources from this adapter as SIMULATED.

const NO_STATS: QueryStats = { bytesProcessed: null, bytesBilled: null };

function schema(ref: DatasetRef): string {
  if (ref.provider !== "local") throw new WarehouseError("invalid", "LocalWarehouse received a non-local dataset ref");
  return `"${assertSafeIdentifier(ref.datasetId, "dataset id")}"`;
}

function mapPgError(err: unknown): never {
  const e = err as { code?: string; message?: string };
  if (e.code === "57014") throw new WarehouseError("timeout", "local warehouse statement timeout");
  if (e.code === "ECONNREFUSED" || e.code === "57P01" || e.code === "53300")
    throw new WarehouseError("unavailable", `local warehouse unavailable (${e.code})`);
  if (e.code === "42P01" || e.code === "3F000") throw new WarehouseError("not_found", "dataset or table not found");
  if (e.code === "42501") throw new WarehouseError("permission_denied", "permission denied");
  if (err instanceof WarehouseError) throw err;
  throw new WarehouseError("unknown", e.message ?? "unknown local warehouse error");
}

export async function ensureLocalWarehouseDatabase(adminUrl: string, warehouseUrl: string): Promise<void> {
  const dbName = new URL(warehouseUrl).pathname.replace(/^\//, "");
  assertSafeIdentifier(dbName, "warehouse database name");
  // Hosted Supabase: the simulated warehouse may live in the main database
  // (one schema per company dataset); nothing to create then.
  if (dbName === new URL(adminUrl).pathname.replace(/^\//, "")) return;
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    const exists = await admin.query("select 1 from pg_database where datname = $1", [dbName]);
    if (exists.rowCount === 0) {
      try {
        await admin.query(`create database "${dbName}"`);
      } catch (err) {
        if ((err as { code?: string }).code !== "42P04") throw err; // created concurrently
      }
    }
  } finally {
    await admin.end();
  }
}

export class LocalWarehouse implements Warehouse {
  readonly provider = "local" as const;
  readonly isSimulated = true;
  private pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new pg.Pool({ connectionString, max: 5, statement_timeout: 30_000 });
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async ensureDataset(ref: DatasetRef, labels: DatasetLabels): Promise<"created" | "exists"> {
    const s = schema(ref);
    try {
      const existed = await this.pool.query("select 1 from pg_namespace where nspname = $1", [ref.datasetId]);
      if (existed.rowCount) return "exists";
      const client = await this.pool.connect();
      try {
        await client.query("begin");
        await client.query(`create schema ${s}`);
        await client.query(`create table ${s}._dataset_meta (key text primary key, value text not null)`);
        await client.query(
          `insert into ${s}._dataset_meta (key, value) values ('mip_company', $1), ('mip_workspace', $2), ('mip_env', $3)`,
          [labels.mip_company, labels.mip_workspace, labels.mip_env],
        );
        await client.query("commit");
        return "created";
      } catch (err) {
        await client.query("rollback");
        // Created concurrently by another worker → treat as existing; caller verifies labels.
        if ((err as { code?: string }).code === "42P06") return "exists";
        throw err;
      } finally {
        client.release();
      }
    } catch (err) {
      mapPgError(err);
    }
  }

  async getDatasetLabels(ref: DatasetRef): Promise<Partial<DatasetLabels> | null> {
    const s = schema(ref);
    try {
      const exists = await this.pool.query("select 1 from pg_namespace where nspname = $1", [ref.datasetId]);
      if (!exists.rowCount) return null;
      const r = await this.pool.query<{ key: string; value: string }>(`select key, value from ${s}._dataset_meta`);
      return Object.fromEntries(r.rows.map((x) => [x.key, x.value])) as Partial<DatasetLabels>;
    } catch (err) {
      mapPgError(err);
    }
  }

  async queryRaw(ref: DatasetRef, syncRunIds: string[], limit: number, source?: string): Promise<{ rows: RawRecord[]; stats: QueryStats }> {
    const s = schema(ref);
    if (syncRunIds.length === 0) return { rows: [], stats: NO_STATS };
    try {
      const r = await this.pool.query(
        `select * from (
           select distinct on (record_date, source, payload_json)
             record_id, sync_run_id, origin, source, to_char(record_date, 'YYYY-MM-DD') as record_date,
             to_char(ingested_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as ingested_at,
             payload_json::text as payload_json, is_simulated, schema_version
           from ${s}.raw_records
           where sync_run_id = any($1::text[]) and record_date >= current_date - 400 and ($3::text is null or source = $3)
           order by record_date, source, payload_json, ingested_at desc) d
         order by record_date desc, source, ingested_at desc
         limit $2`,
        [syncRunIds, Math.min(Math.max(limit, 1), 2000), source ?? null],
      );
      return { rows: r.rows as RawRecord[], stats: NO_STATS };
    } catch (err) {
      mapPgError(err);
    }
  }

  async queryRawPage(ref: DatasetRef, q: RawPageQuery): Promise<{ rows: RawRecord[]; total: number; stats: QueryStats }> {
    const s = schema(ref);
    if (q.syncRunIds.length === 0) return { rows: [], total: 0, stats: NO_STATS };
    const params: unknown[] = [q.syncRunIds];
    const p = (v: unknown) => {
      params.push(v);
      return `$${params.length}`;
    };
    const where = [`sync_run_id = any($1::text[])`];
    if (q.source) where.push(`source = ${p(q.source)}`);
    if (q.from) where.push(`record_date >= ${p(q.from)}::date`);
    if (q.to) where.push(`record_date <= ${p(q.to)}::date`);
    const col = (path: RawPath) => `(payload_json #>> ${p(assertRawPath(path))}::text[])`;
    const num = (expr: string) => `(case when ${expr} ~ '^-?[0-9]+([.][0-9]+)?([eE][-+]?[0-9]+)?$' then (${expr})::float8 end)`;
    for (const f of (q.filters ?? []).slice(0, 5)) {
      const c = col(f.path);
      if (f.op === "contains") where.push(`strpos(lower(${c}), lower(${p(f.value)})) > 0`);
      else if (f.op === "eq") where.push(`lower(${c}) = lower(${p(f.value)})`);
      else where.push(`${num(c)} ${f.op === "gt" ? ">" : "<"} ${p(Number(f.value))}::float8`);
    }
    const countParams = [...params]; // the count uses only the filter parameters
    const dir = q.sort?.dir === "asc" ? "asc" : "desc";
    let order = `record_date ${dir}, source, ingested_at desc`;
    if (q.sort && Array.isArray(q.sort.by)) {
      const c = col(q.sort.by);
      order = `${num(c)} ${dir} nulls last, ${c} ${dir} nulls last, record_date desc`;
    } else if (q.sort?.by === "ingested_at") order = `ingested_at ${dir}, record_date desc`;
    try {
      const w = where.join(" and ");
      const total = await this.pool.query<{ n: number }>(`select count(*)::int as n from ${s}.raw_records where ${w}`, countParams);
      const lim = p(Math.min(Math.max(q.limit, 1), 50000));
      const off = p(Math.max(q.offset, 0));
      const r = await this.pool.query(
        `select record_id, sync_run_id, origin, source, to_char(record_date, 'YYYY-MM-DD') as record_date,
           to_char(ingested_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as ingested_at,
           payload_json::text as payload_json, is_simulated, schema_version
         from ${s}.raw_records where ${w} order by ${order} limit ${lim} offset ${off}`,
        params,
      );
      return { rows: r.rows as RawRecord[], total: total.rows[0]?.n ?? 0, stats: NO_STATS };
    } catch (err) {
      mapPgError(err);
    }
  }

  async rawValues(ref: DatasetRef, q: { syncRunIds: string[]; source?: string; path: RawPath; limit: number }): Promise<string[]> {
    const s = schema(ref);
    if (q.syncRunIds.length === 0) return [];
    try {
      const r = await this.pool.query<{ v: string }>(
        `select payload_json #>> $3::text[] as v from ${s}.raw_records
          where sync_run_id = any($1::text[]) and ($2::text is null or source = $2) and payload_json #>> $3::text[] is not null
          group by 1 order by count(*) desc, 1 limit $4`,
        [q.syncRunIds, q.source ?? null, assertRawPath(q.path), Math.min(Math.max(q.limit, 1), 100)],
      );
      return r.rows.map((x) => x.v);
    } catch (err) {
      mapPgError(err);
    }
  }

  async deleteConnectionData(
    ref: DatasetRef,
    scope: { origin: string; isSimulated: boolean; accountId: string | null; syncRunIds: string[]; range?: DateRange; rawSources?: string[]; skipNormalized?: boolean },
  ): Promise<{ range: DateRange | null }> {
    const s = schema(ref);
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const del = scope.skipNormalized ? { rows: [] as { from: string | null; to: string | null }[] } : await client.query<{ from: string | null; to: string | null }>(
        `with d as (
           delete from ${s}.norm_campaign_daily
            where origin = $1 and is_simulated = $2 and ($3::text is null or account_id = $3)
              and ($4::date is null or metric_date between $4::date and $5::date)
            returning metric_date)
         select to_char(min(metric_date), 'YYYY-MM-DD') as "from", to_char(max(metric_date), 'YYYY-MM-DD') as "to" from d`,
        [scope.origin, scope.isSimulated, scope.accountId, scope.range?.from ?? null, scope.range?.to ?? null],
      );
      if (scope.syncRunIds.length) {
        await client.query(
          `delete from ${s}.raw_records where sync_run_id = any($1::text[]) and ($2::date is null or record_date between $2::date and $3::date)
             and ($4::text[] is null or source = any($4::text[]))`,
          [scope.syncRunIds, scope.range?.from ?? null, scope.range?.to ?? null, scope.rawSources ?? null],
        );
      }
      await client.query("commit");
      const row = del.rows[0];
      return { range: row?.from && row.to ? { from: row.from, to: row.to } : null };
    } catch (err) {
      await client.query("rollback").catch(() => undefined);
      mapPgError(err);
    } finally {
      client.release();
    }
  }

  async clearData(ref: DatasetRef): Promise<void> {
    const s = schema(ref);
    try {
      await this.pool.query(`truncate ${s}.raw_records, ${s}.norm_campaign_daily, ${s}.mart_daily_source`);
    } catch (err) {
      mapPgError(err);
    }
  }

  async deleteDataset(ref: DatasetRef): Promise<"deleted" | "not_found"> {
    const s = schema(ref);
    try {
      const exists = await this.pool.query("select 1 from pg_namespace where nspname = $1", [ref.datasetId]);
      if (!exists.rowCount) return "not_found";
      await this.pool.query(`drop schema if exists ${s} cascade`);
      return "deleted";
    } catch (err) {
      mapPgError(err);
    }
  }

  async ensureSchema(ref: DatasetRef, version: number = CURRENT_SCHEMA_VERSION): Promise<number> {
    const s = schema(ref);
    if (version !== 1) throw new WarehouseError("invalid", `unknown schema version ${version}`);
    try {
      await this.pool.query(`
        create table if not exists ${s}._schema_migrations (version int primary key, applied_at timestamptz not null default now());
        create table if not exists ${s}.raw_records (
          record_id text primary key, sync_run_id text not null, origin text not null, source text not null,
          record_date date not null, ingested_at timestamptz not null, payload_json jsonb not null,
          is_simulated boolean not null, schema_version int not null);
        create index if not exists raw_records_date_idx on ${s}.raw_records (record_date, origin);
        create table if not exists ${s}.norm_campaign_daily (
          row_key text not null unique, metric_date date not null, origin text not null, source text not null,
          account_id text not null, account_name text, campaign_id text not null, campaign_name text,
          currency text, source_timezone text not null,
          impressions bigint, clicks bigint, spend numeric, sessions bigint, conversions numeric,
          conversion_type text, leads bigint, attributed_revenue numeric, billed_revenue numeric,
          data_status text not null, is_simulated boolean not null, sync_run_id text not null, updated_at timestamptz not null,
          primary key (metric_date, origin, source, account_id, campaign_id));
        create table if not exists ${s}.mart_daily_source (
          metric_date date not null, origin text not null, source text not null, currency text,
          is_simulated boolean not null, impressions bigint, clicks bigint, spend numeric, sessions bigint,
          conversions numeric, conversion_type text, leads bigint, attributed_revenue numeric, billed_revenue numeric,
          campaign_count int not null, has_preliminary boolean not null, refreshed_at timestamptz not null);
        create index if not exists mart_daily_source_date_idx on ${s}.mart_daily_source (metric_date);
        insert into ${s}._schema_migrations (version) values (1) on conflict do nothing;
      `);
      const r = await this.pool.query<{ v: number }>(`select max(version)::int as v from ${s}._schema_migrations`);
      return r.rows[0]?.v ?? 0;
    } catch (err) {
      mapPgError(err);
    }
  }

  async insertRaw(ref: DatasetRef, rows: RawRecord[]): Promise<{ written: number; stats: QueryStats }> {
    const s = schema(ref);
    if (rows.length === 0) return { written: 0, stats: NO_STATS };
    try {
      const r = await this.pool.query(
        `insert into ${s}.raw_records
           select * from jsonb_to_recordset($1::jsonb) as x(record_id text, sync_run_id text, origin text, source text,
             record_date date, ingested_at timestamptz, payload_json jsonb, is_simulated boolean, schema_version int)
         on conflict (record_id) do update set sync_run_id = excluded.sync_run_id, ingested_at = excluded.ingested_at,
           payload_json = excluded.payload_json, is_simulated = excluded.is_simulated, schema_version = excluded.schema_version`,
        [JSON.stringify(rows.map((row) => ({ ...row, payload_json: JSON.parse(row.payload_json) })))],
      );
      return { written: r.rowCount ?? 0, stats: NO_STATS };
    } catch (err) {
      mapPgError(err);
    }
  }

  async upsertNormalized(ref: DatasetRef, rows: NormalizedRow[]): Promise<{ written: number; stats: QueryStats }> {
    const s = schema(ref);
    if (rows.length === 0) return { written: 0, stats: NO_STATS };
    try {
      const r = await this.pool.query(
        `insert into ${s}.norm_campaign_daily
           select * from jsonb_to_recordset($1::jsonb) as x(row_key text, metric_date date, origin text, source text,
             account_id text, account_name text, campaign_id text, campaign_name text, currency text, source_timezone text,
             impressions bigint, clicks bigint, spend numeric, sessions bigint, conversions numeric, conversion_type text,
             leads bigint, attributed_revenue numeric, billed_revenue numeric, data_status text, is_simulated boolean,
             sync_run_id text, updated_at timestamptz)
         on conflict (metric_date, origin, source, account_id, campaign_id) do update set
           row_key = excluded.row_key, account_name = excluded.account_name, campaign_name = excluded.campaign_name,
           currency = excluded.currency, source_timezone = excluded.source_timezone,
           impressions = excluded.impressions, clicks = excluded.clicks, spend = excluded.spend,
           sessions = excluded.sessions, conversions = excluded.conversions, conversion_type = excluded.conversion_type,
           leads = excluded.leads, attributed_revenue = excluded.attributed_revenue, billed_revenue = excluded.billed_revenue,
           data_status = excluded.data_status, is_simulated = excluded.is_simulated,
           sync_run_id = excluded.sync_run_id, updated_at = excluded.updated_at`,
        [JSON.stringify(rows)],
      );
      return { written: r.rowCount ?? 0, stats: NO_STATS };
    } catch (err) {
      mapPgError(err);
    }
  }

  async removeDuplicates(ref: DatasetRef, range: DateRange): Promise<{ raw: number; normalized: number }> {
    // Postgres enforces uniqueness itself (primary keys on record_id and on the normalized grain),
    // so this only verifies it — the same check the BigQuery warehouse needs to act on.
    const s = schema(ref);
    try {
      const r = await this.pool.query<{ raw: number; normalized: number }>(
        `select (select count(*) - count(distinct record_id) from ${s}.raw_records where record_date between $1 and $2)::int as raw,
                (select count(*) - count(distinct (metric_date, origin, source, account_id, campaign_id))
                   from ${s}.norm_campaign_daily where metric_date between $1 and $2)::int as normalized`,
        [range.from, range.to],
      );
      return { raw: r.rows[0]?.raw ?? 0, normalized: r.rows[0]?.normalized ?? 0 };
    } catch (err) {
      mapPgError(err);
    }
  }

  // GA4's BigQuery export exists only in real BigQuery.
  async ga4ExportRange(): Promise<{ first: string; last: string } | null> {
    return null;
  }

  async queryGa4Export(): Promise<{ rows: Record<string, string>[]; stats: QueryStats }> {
    throw new WarehouseError("invalid", "the GA4 BigQuery export is available only with the BigQuery warehouse");
  }

  async rebuildMart(ref: DatasetRef, range: DateRange): Promise<{ stats: QueryStats }> {
    const s = schema(ref);
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await client.query(`delete from ${s}.mart_daily_source where metric_date between $1 and $2`, [range.from, range.to]);
      await client.query(
        `insert into ${s}.mart_daily_source
         select metric_date, origin, source, currency, is_simulated,
           sum(impressions), sum(clicks), sum(spend), sum(sessions), sum(conversions),
           case when count(distinct conversion_type) = 1 then min(conversion_type) else null end,
           sum(leads), sum(attributed_revenue), sum(billed_revenue),
           count(*)::int, bool_or(data_status = 'preliminary'), now()
         from ${s}.norm_campaign_daily
         where metric_date between $1 and $2
         group by metric_date, origin, source, currency, is_simulated`,
        [range.from, range.to],
      );
      await client.query("commit");
      return { stats: NO_STATS };
    } catch (err) {
      await client.query("rollback").catch(() => undefined);
      mapPgError(err);
    } finally {
      client.release();
    }
  }

  async queryDaily(ref: DatasetRef, range: DateRange): Promise<{ rows: MartRow[]; stats: QueryStats }> {
    const s = schema(ref);
    try {
      const r = await this.pool.query(
        `select to_char(metric_date, 'YYYY-MM-DD') as metric_date, origin, source, currency, is_simulated,
           impressions::float8 as impressions, clicks::float8 as clicks, spend::float8 as spend, sessions::float8 as sessions,
           conversions::float8 as conversions, conversion_type, leads::float8 as leads,
           attributed_revenue::float8 as attributed_revenue, billed_revenue::float8 as billed_revenue,
           campaign_count, has_preliminary
         from ${s}.mart_daily_source where metric_date between $1 and $2
         order by metric_date, origin, source`,
        [range.from, range.to],
      );
      return { rows: r.rows as MartRow[], stats: NO_STATS };
    } catch (err) {
      mapPgError(err);
    }
  }

  async queryCampaigns(ref: DatasetRef, range: DateRange, limit: number): Promise<{ rows: CampaignRow[]; stats: QueryStats }> {
    const s = schema(ref);
    try {
      const r = await this.pool.query(
        `select origin, source, account_id, max(account_name) as account_name, campaign_id, max(campaign_name) as campaign_name,
           currency, bool_or(is_simulated) as is_simulated,
           sum(impressions)::float8 as impressions, sum(clicks)::float8 as clicks, sum(spend)::float8 as spend,
           sum(sessions)::float8 as sessions, sum(conversions)::float8 as conversions,
           case when count(distinct conversion_type) = 1 then min(conversion_type) else null end as conversion_type,
           sum(leads)::float8 as leads, sum(attributed_revenue)::float8 as attributed_revenue,
           to_char(min(metric_date), 'YYYY-MM-DD') as first_date, to_char(max(metric_date), 'YYYY-MM-DD') as last_date
         from ${s}.norm_campaign_daily where metric_date between $1 and $2
         group by origin, source, account_id, campaign_id, currency
         order by sum(spend) desc nulls last, sum(clicks) desc nulls last, sum(sessions) desc nulls last
         limit $3`,
        [range.from, range.to, limit],
      );
      return { rows: r.rows as CampaignRow[], stats: NO_STATS };
    } catch (err) {
      mapPgError(err);
    }
  }

  async coveredDates(ref: DatasetRef, origin: string, range: DateRange): Promise<string[]> {
    const s = schema(ref);
    try {
      const r = await this.pool.query<{ d: string }>(
        `select distinct to_char(metric_date, 'YYYY-MM-DD') as d from ${s}.norm_campaign_daily
         where origin = $1 and metric_date between $2 and $3 order by 1`,
        [origin, range.from, range.to],
      );
      return r.rows.map((x) => x.d);
    } catch (err) {
      mapPgError(err);
    }
  }
}
