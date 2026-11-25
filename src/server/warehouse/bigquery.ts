import type { BigQuery } from "@google-cloud/bigquery";
import type { CampaignRow, MartRow, NormalizedRow, RawRecord } from "../../lib/model";
import { assertSafeIdentifier, assertSafeProjectId } from "./datasetId";
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

// REAL BigQuery adapter (official @google-cloud/bigquery SDK).
// Credentials: Application Default Credentials on the server only. Every query
// sets maximumBytesBilled; every table is date-partitioned and clustered; all
// identifiers come from the resource registry and are validated before use.
// Requires a billing-enabled project: DML (MERGE/DELETE) is not available in
// the BigQuery sandbox.

const BATCH = 500;

export function mapBigQueryError(err: unknown): WarehouseError {
  if (err instanceof WarehouseError) return err;
  const e = err as { code?: number | string; message?: string; errors?: { reason?: string }[]; name?: string };
  const reason = e.errors?.[0]?.reason ?? "";
  const msg = (e.message ?? "BigQuery error").slice(0, 500);
  if (e.code === "ETIMEDOUT" || e.code === "ESOCKETTIMEDOUT" || e.name === "AbortError" || reason === "timeout" || /timed? ?out/i.test(msg))
    return new WarehouseError("timeout", msg);
  if (e.code === "ECONNRESET" || e.code === "ECONNREFUSED" || e.code === "EAI_AGAIN") return new WarehouseError("unavailable", msg);
  if (reason === "bytesBilledLimitExceeded") return new WarehouseError("bytes_limit_exceeded", msg);
  if (reason === "rateLimitExceeded" || e.code === 429) return new WarehouseError("rate_limited", msg);
  if (reason === "quotaExceeded") return new WarehouseError("quota_exceeded", msg);
  if (e.code === 409 || reason === "duplicate") return new WarehouseError("already_exists", msg);
  if (e.code === 404 || reason === "notFound") return new WarehouseError("not_found", msg);
  if (e.code === 401 || e.code === 403 || reason === "accessDenied") return new WarehouseError("permission_denied", msg);
  if (e.code === 500 || e.code === 502 || e.code === 503 || reason === "backendError" || reason === "internalError")
    return new WarehouseError("unavailable", msg);
  if (e.code === 400 || reason === "invalid" || reason === "invalidQuery") return new WarehouseError("invalid", msg);
  return new WarehouseError("unknown", msg);
}

const NORM_TYPES = {
  row_key: "STRING",
  metric_date: "DATE",
  origin: "STRING",
  source: "STRING",
  account_id: "STRING",
  account_name: "STRING",
  campaign_id: "STRING",
  campaign_name: "STRING",
  currency: "STRING",
  source_timezone: "STRING",
  impressions: "INT64",
  clicks: "INT64",
  spend: "NUMERIC",
  sessions: "INT64",
  conversions: "FLOAT64",
  conversion_type: "STRING",
  leads: "INT64",
  attributed_revenue: "NUMERIC",
  billed_revenue: "NUMERIC",
  data_status: "STRING",
  is_simulated: "BOOL",
  sync_run_id: "STRING",
  updated_at: "TIMESTAMP",
} as const;

const RAW_TYPES = {
  record_id: "STRING",
  sync_run_id: "STRING",
  origin: "STRING",
  source: "STRING",
  record_date: "DATE",
  ingested_at: "TIMESTAMP",
  payload_json: "STRING",
  is_simulated: "BOOL",
  schema_version: "INT64",
} as const;

const NORM_COLS = Object.keys(NORM_TYPES);
const METRIC_UPDATE_COLS = NORM_COLS.filter(
  (c) => !["metric_date", "origin", "source", "account_id", "campaign_id"].includes(c),
);

/**
 * The BigQuery client reads DATE/TIME/TIMESTAMP parameter values from `.value`
 * (it expects BigQuery.date()/timestamp() objects). A plain string would be sent
 * as NULL, so typed string values are wrapped, recursively through arrays and structs.
 */
export function wrapTypedParams(value: unknown, type: unknown): unknown {
  if (value === null || value === undefined) return value ?? null;
  if (typeof type === "string") {
    return typeof value === "string" && /^(DATE|DATETIME|TIME|TIMESTAMP)$/.test(type) ? { value } : value;
  }
  if (Array.isArray(type)) return Array.isArray(value) ? value.map((v) => wrapTypedParams(v, type[0])) : value;
  if (type && typeof type === "object" && typeof value === "object" && !Array.isArray(value)) {
    const t = type as Record<string, unknown>;
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, k in t ? wrapTypedParams(v, t[k]) : v]));
  }
  return value;
}

export function schemaDdl(fq: (t: string) => string): string[] {
  return [
    `CREATE TABLE IF NOT EXISTS ${fq("_schema_migrations")} (version INT64 NOT NULL, applied_at TIMESTAMP NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS ${fq("raw_records")} (
      record_id STRING NOT NULL, sync_run_id STRING NOT NULL, origin STRING NOT NULL, source STRING NOT NULL,
      record_date DATE NOT NULL, ingested_at TIMESTAMP NOT NULL, payload_json STRING NOT NULL,
      is_simulated BOOL NOT NULL, schema_version INT64 NOT NULL)
     PARTITION BY record_date CLUSTER BY origin, source
     OPTIONS (description = 'RAW layer: source-faithful records with ingestion metadata')`,
    `CREATE TABLE IF NOT EXISTS ${fq("norm_campaign_daily")} (
      row_key STRING NOT NULL, metric_date DATE NOT NULL, origin STRING NOT NULL, source STRING NOT NULL,
      account_id STRING NOT NULL, account_name STRING, campaign_id STRING NOT NULL, campaign_name STRING,
      currency STRING, source_timezone STRING NOT NULL,
      impressions INT64, clicks INT64, spend NUMERIC, sessions INT64, conversions FLOAT64, conversion_type STRING,
      leads INT64, attributed_revenue NUMERIC, billed_revenue NUMERIC,
      data_status STRING NOT NULL, is_simulated BOOL NOT NULL, sync_run_id STRING NOT NULL, updated_at TIMESTAMP NOT NULL)
     PARTITION BY metric_date CLUSTER BY origin, source, campaign_id
     OPTIONS (description = 'NORMALIZED layer: grain = date x origin x source x account x campaign')`,
    `CREATE TABLE IF NOT EXISTS ${fq("mart_daily_source")} (
      metric_date DATE NOT NULL, origin STRING NOT NULL, source STRING NOT NULL, currency STRING, is_simulated BOOL NOT NULL,
      impressions INT64, clicks INT64, spend NUMERIC, sessions INT64, conversions FLOAT64, conversion_type STRING,
      leads INT64, attributed_revenue NUMERIC, billed_revenue NUMERIC,
      campaign_count INT64 NOT NULL, has_preliminary BOOL NOT NULL, refreshed_at TIMESTAMP NOT NULL)
     PARTITION BY metric_date CLUSTER BY origin, source
     OPTIONS (description = 'MART layer: daily KPIs per source for the dashboard')`,
  ];
}

export class BigQueryWarehouse implements Warehouse {
  readonly provider = "bigquery" as const;
  readonly isSimulated = false;

  constructor(
    private readonly client: BigQuery,
    private readonly opts: { maxBytesBilled: number; billingApproved: boolean },
  ) {}

  private fq(ref: DatasetRef, table: string): string {
    if (ref.provider !== "bigquery") throw new WarehouseError("invalid", "BigQueryWarehouse received a non-BigQuery ref");
    return `\`${assertSafeProjectId(ref.projectId)}.${assertSafeIdentifier(ref.datasetId, "dataset id")}.${assertSafeIdentifier(table, "table")}\``;
  }

  private async run(
    ref: DatasetRef,
    query: string,
    params?: Record<string, unknown>,
    types?: Record<string, unknown>,
  ): Promise<{ rows: Record<string, unknown>[]; stats: QueryStats }> {
    try {
      const [job] = await this.client.createQueryJob({
        query,
        params: params && types ? (wrapTypedParams(params, types) as Record<string, unknown>) : params,
        types: types as never,
        location: ref.location,
        useLegacySql: false,
        maximumBytesBilled: String(this.opts.maxBytesBilled),
        jobTimeoutMs: 120_000,
        labels: { mip_component: "app" },
      });
      const [rows] = await job.getQueryResults({ timeoutMs: 120_000 });
      const stats = (job.metadata?.statistics ?? {}) as { totalBytesProcessed?: string; query?: { totalBytesBilled?: string } };
      return {
        rows: rows as Record<string, unknown>[],
        stats: {
          bytesProcessed: stats.totalBytesProcessed ? Number(stats.totalBytesProcessed) : null,
          bytesBilled: stats.query?.totalBytesBilled ? Number(stats.query.totalBytesBilled) : null,
        },
      };
    } catch (err) {
      throw mapBigQueryError(err);
    }
  }

  async ensureDataset(ref: DatasetRef, labels: DatasetLabels): Promise<"created" | "exists"> {
    if (!this.opts.billingApproved) {
      throw new WarehouseError(
        "permission_denied",
        "BigQuery dataset creation is disabled: set BIGQUERY_BILLING_APPROVED=true after the project owner approves billing",
      );
    }
    assertSafeProjectId(ref.projectId);
    assertSafeIdentifier(ref.datasetId, "dataset id");
    try {
      await this.client.dataset(ref.datasetId, { projectId: ref.projectId }).create({
        location: ref.location,
        labels: { ...labels },
        description: "Marketing Intelligence Platform company dataset (managed; do not edit by hand)",
      });
      return "created";
    } catch (err) {
      const mapped = mapBigQueryError(err);
      if (mapped.code === "already_exists") return "exists";
      throw mapped;
    }
  }

  async getDatasetLabels(ref: DatasetRef): Promise<Partial<DatasetLabels> | null> {
    try {
      const [meta] = await this.client.dataset(assertSafeIdentifier(ref.datasetId), { projectId: ref.projectId }).getMetadata();
      const location = (meta as { location?: string }).location;
      if (location && location.toUpperCase() !== ref.location.toUpperCase()) {
        throw new WarehouseError("invalid", `dataset location ${location} does not match registry location ${ref.location}`);
      }
      return ((meta as { labels?: Record<string, string> }).labels ?? {}) as Partial<DatasetLabels>;
    } catch (err) {
      const mapped = mapBigQueryError(err);
      if (mapped.code === "not_found") return null;
      throw mapped;
    }
  }

  async queryRaw(ref: DatasetRef, syncRunIds: string[], limit: number, source?: string): Promise<{ rows: RawRecord[]; stats: QueryStats }> {
    if (syncRunIds.length === 0) return { rows: [], stats: { bytesProcessed: null, bytesBilled: null } };
    const res = await this.run(
      ref,
      `SELECT record_id, sync_run_id, origin, source, CAST(record_date AS STRING) AS record_date,
         FORMAT_TIMESTAMP('%Y-%m-%dT%H:%M:%SZ', ingested_at) AS ingested_at, payload_json, is_simulated, schema_version
       FROM ${this.fq(ref, "raw_records")}
       WHERE sync_run_id IN UNNEST(@ids) AND record_date >= DATE_SUB(CURRENT_DATE(), INTERVAL 400 DAY)
         AND (@src IS NULL OR source = @src)
       QUALIFY ROW_NUMBER() OVER (PARTITION BY record_date, source, payload_json ORDER BY ingested_at DESC) = 1
       ORDER BY record_date DESC, source, ingested_at DESC
       LIMIT @lim`,
      { ids: syncRunIds, lim: Math.min(Math.max(limit, 1), 2000), src: source ?? null },
      { ids: ["STRING"], lim: "INT64", src: "STRING" },
    );
    return { rows: res.rows as unknown as RawRecord[], stats: res.stats };
  }

  async queryRawPage(ref: DatasetRef, q: RawPageQuery): Promise<{ rows: RawRecord[]; total: number; stats: QueryStats }> {
    if (q.syncRunIds.length === 0) return { rows: [], total: 0, stats: { bytesProcessed: null, bytesBilled: null } };
    const params: Record<string, unknown> = { ids: q.syncRunIds };
    const types: Record<string, unknown> = { ids: ["STRING"] };
    const where = ["sync_run_id IN UNNEST(@ids)"];
    if (q.source) { where.push("source = @src"); params.src = q.source; types.src = "STRING"; }
    if (q.from) { where.push("record_date >= @from"); params.from = q.from; types.from = "DATE"; }
    if (q.to) { where.push("record_date <= @to"); params.to = q.to; types.to = "DATE"; }
    // Paths are validated to [A-Za-z0-9_] segments, so they are safe to inline as a JSONPath literal.
    const col = (path: RawPath) =>
      `JSON_VALUE(payload_json, '$${assertRawPath(path).map((seg) => (/^\d+$/.test(seg) ? `[${seg}]` : `.${seg}`)).join("")}')`;
    (q.filters ?? []).slice(0, 5).forEach((f, i) => {
      const c = col(f.path);
      const name = `f${i}`;
      if (f.op === "contains") { where.push(`STRPOS(LOWER(${c}), LOWER(@${name})) > 0`); params[name] = f.value; types[name] = "STRING"; }
      else if (f.op === "eq") { where.push(`LOWER(${c}) = LOWER(@${name})`); params[name] = f.value; types[name] = "STRING"; }
      else { where.push(`SAFE_CAST(${c} AS FLOAT64) ${f.op === "gt" ? ">" : "<"} @${name}`); params[name] = Number(f.value); types[name] = "FLOAT64"; }
    });
    const dir = q.sort?.dir === "asc" ? "ASC" : "DESC";
    let order = `record_date ${dir}, source, ingested_at DESC`;
    if (q.sort && Array.isArray(q.sort.by)) {
      const c = col(q.sort.by);
      order = `SAFE_CAST(${c} AS FLOAT64) ${dir} NULLS LAST, ${c} ${dir} NULLS LAST, record_date DESC`;
    } else if (q.sort?.by === "ingested_at") order = `ingested_at ${dir}, record_date DESC`;
    const w = where.join(" AND ");
    const total = await this.run(ref, `SELECT COUNT(*) AS n FROM ${this.fq(ref, "raw_records")} WHERE ${w}`, params, types);
    const res = await this.run(
      ref,
      `SELECT record_id, sync_run_id, origin, source, CAST(record_date AS STRING) AS record_date,
         FORMAT_TIMESTAMP('%Y-%m-%dT%H:%M:%SZ', ingested_at) AS ingested_at, payload_json, is_simulated, schema_version
       FROM ${this.fq(ref, "raw_records")} WHERE ${w}
       ORDER BY ${order}
       LIMIT @lim OFFSET @off`,
      { ...params, lim: Math.min(Math.max(q.limit, 1), 50000), off: Math.max(q.offset, 0) },
      { ...types, lim: "INT64", off: "INT64" },
    );
    const n = (total.rows[0] as { n?: unknown } | undefined)?.n;
    return { rows: res.rows as unknown as RawRecord[], total: Number(n ?? 0), stats: res.stats };
  }

  async rawValues(ref: DatasetRef, q: { syncRunIds: string[]; source?: string; path: RawPath; limit: number }): Promise<string[]> {
    if (q.syncRunIds.length === 0) return [];
    const jsonPath = `$${assertRawPath(q.path).map((seg) => (/^\d+$/.test(seg) ? `[${seg}]` : `.${seg}`)).join("")}`;
    const res = await this.run(
      ref,
      `SELECT JSON_VALUE(payload_json, '${jsonPath}') AS v FROM ${this.fq(ref, "raw_records")}
        WHERE sync_run_id IN UNNEST(@ids) AND (@src IS NULL OR source = @src) AND JSON_VALUE(payload_json, '${jsonPath}') IS NOT NULL
        GROUP BY v ORDER BY COUNT(*) DESC, v LIMIT @lim`,
      { ids: q.syncRunIds, src: q.source ?? null, lim: Math.min(Math.max(q.limit, 1), 100) },
      { ids: ["STRING"], src: "STRING", lim: "INT64" },
    );
    return res.rows.map((r) => String((r as { v: unknown }).v));
  }

  async deleteConnectionData(
    ref: DatasetRef,
    scope: { origin: string; isSimulated: boolean; accountId: string | null; syncRunIds: string[]; range?: DateRange; rawSources?: string[]; skipNormalized?: boolean },
  ): Promise<{ range: DateRange | null }> {
    const where = `origin = @origin AND is_simulated = @sim AND (@acct IS NULL OR account_id = @acct)
      AND (@from IS NULL OR metric_date BETWEEN @from AND @to)`;
    const params = { origin: scope.origin, sim: scope.isSimulated, acct: scope.accountId, from: scope.range?.from ?? null, to: scope.range?.to ?? null };
    const types = { origin: "STRING", sim: "BOOL", acct: "STRING", from: "DATE", to: "DATE" };
    let r: { rows: Record<string, unknown>[] } = { rows: [] };
    if (!scope.skipNormalized) {
      r = await this.run(
        ref,
        `SELECT CAST(MIN(metric_date) AS STRING) AS f, CAST(MAX(metric_date) AS STRING) AS t FROM ${this.fq(ref, "norm_campaign_daily")} WHERE ${where}`,
        params,
        types,
      );
      await this.run(ref, `DELETE FROM ${this.fq(ref, "norm_campaign_daily")} WHERE ${where}`, params, types);
    }
    if (scope.syncRunIds.length) {
      await this.run(
        ref,
        `DELETE FROM ${this.fq(ref, "raw_records")} WHERE sync_run_id IN UNNEST(@ids) AND (@from IS NULL OR record_date BETWEEN @from AND @to)
           AND (@all_src OR source IN UNNEST(@srcs))`,
        { ids: scope.syncRunIds, from: scope.range?.from ?? null, to: scope.range?.to ?? null, all_src: !scope.rawSources, srcs: scope.rawSources ?? [] },
        { ids: ["STRING"], from: "DATE", to: "DATE", all_src: "BOOL", srcs: ["STRING"] },
      );
    }
    const row = r.rows[0] as { f?: string | null; t?: string | null } | undefined;
    return { range: row?.f && row.t ? { from: row.f, to: row.t } : null };
  }

  async clearData(ref: DatasetRef): Promise<void> {
    for (const t of ["raw_records", "norm_campaign_daily", "mart_daily_source"]) {
      await this.run(ref, `TRUNCATE TABLE ${this.fq(ref, t)}`);
    }
  }

  async deleteDataset(ref: DatasetRef): Promise<"deleted" | "not_found"> {
    assertSafeProjectId(ref.projectId);
    assertSafeIdentifier(ref.datasetId, "dataset id");
    try {
      // force: also deletes the dataset's tables. Deleting never bills, so it is
      // allowed even when BIGQUERY_BILLING_APPROVED is not set.
      await this.client.dataset(ref.datasetId, { projectId: ref.projectId }).delete({ force: true });
      return "deleted";
    } catch (err) {
      const mapped = mapBigQueryError(err);
      if (mapped.code === "not_found") return "not_found";
      throw mapped;
    }
  }

  async ensureSchema(ref: DatasetRef, version: number = CURRENT_SCHEMA_VERSION): Promise<number> {
    if (version !== 1) throw new WarehouseError("invalid", `unknown schema version ${version}`);
    for (const ddl of schemaDdl((t) => this.fq(ref, t))) {
      await this.run(ref, ddl);
    }
    await this.run(
      ref,
      `INSERT INTO ${this.fq(ref, "_schema_migrations")} (version, applied_at)
       SELECT 1, CURRENT_TIMESTAMP() FROM (SELECT 1) WHERE NOT EXISTS (SELECT 1 FROM ${this.fq(ref, "_schema_migrations")} WHERE version = 1)`,
    );
    return 1;
  }

  async insertRaw(ref: DatasetRef, rows: RawRecord[]): Promise<{ written: number; stats: QueryStats }> {
    let written = 0;
    const stats: QueryStats = { bytesProcessed: 0, bytesBilled: 0 };
    for (let i = 0; i < rows.length; i += BATCH) {
      const chunk = rows.slice(i, i + BATCH);
      // MERGE on the stable record_id: a re-sync of the same grain replaces the raw row (no second copy).
      const res = await this.run(
        ref,
        `MERGE ${this.fq(ref, "raw_records")} T
         USING (SELECT * FROM UNNEST(@rows)) S
         ON T.record_id = S.record_id AND T.record_date BETWEEN @min_date AND @max_date
         WHEN MATCHED THEN UPDATE SET sync_run_id = S.sync_run_id, ingested_at = S.ingested_at, payload_json = S.payload_json,
           is_simulated = S.is_simulated, schema_version = S.schema_version
         WHEN NOT MATCHED THEN INSERT (${Object.keys(RAW_TYPES).join(", ")})
           VALUES (${Object.keys(RAW_TYPES).map((c) => `S.${c}`).join(", ")})`,
        {
          rows: chunk,
          min_date: chunk.reduce((m, r) => (r.record_date < m ? r.record_date : m), chunk[0]!.record_date),
          max_date: chunk.reduce((m, r) => (r.record_date > m ? r.record_date : m), chunk[0]!.record_date),
        },
        { rows: [RAW_TYPES], min_date: "DATE", max_date: "DATE" },
      );
      written += chunk.length;
      addStats(stats, res.stats);
    }
    return { written, stats };
  }

  async upsertNormalized(ref: DatasetRef, rows: NormalizedRow[]): Promise<{ written: number; stats: QueryStats }> {
    let written = 0;
    const stats: QueryStats = { bytesProcessed: 0, bytesBilled: 0 };
    for (let i = 0; i < rows.length; i += BATCH) {
      const chunk = rows.slice(i, i + BATCH);
      const res = await this.run(
        ref,
        `MERGE ${this.fq(ref, "norm_campaign_daily")} T
         USING (SELECT * FROM UNNEST(@rows)) S
         ON T.metric_date = S.metric_date AND T.origin = S.origin AND T.source = S.source
            AND T.account_id = S.account_id AND T.campaign_id = S.campaign_id
            AND T.metric_date BETWEEN @min_date AND @max_date
         WHEN MATCHED THEN UPDATE SET ${METRIC_UPDATE_COLS.map((c) => `${c} = S.${c}`).join(", ")}
         WHEN NOT MATCHED THEN INSERT (${NORM_COLS.join(", ")}) VALUES (${NORM_COLS.map((c) => `S.${c}`).join(", ")})`,
        {
          rows: chunk,
          min_date: chunk.reduce((m, r) => (r.metric_date < m ? r.metric_date : m), chunk[0]!.metric_date),
          max_date: chunk.reduce((m, r) => (r.metric_date > m ? r.metric_date : m), chunk[0]!.metric_date),
        },
        { rows: [NORM_TYPES], min_date: "DATE", max_date: "DATE" },
      );
      written += chunk.length;
      addStats(stats, res.stats);
    }
    return { written, stats };
  }

  async removeDuplicates(ref: DatasetRef, range: DateRange): Promise<{ raw: number; normalized: number }> {
    const raw = await this.dedupeTable(ref, "raw_records", "record_date", ["record_id"], "ingested_at", range);
    const normalized = await this.dedupeTable(ref, "norm_campaign_daily", "metric_date", ["metric_date", "origin", "source", "account_id", "campaign_id"], "updated_at", range);
    return { raw, normalized };
  }

  /**
   * BigQuery has no unique constraints, so uniqueness is checked after each write.
   * A cheap read finds keys that occur more than once; only then one MERGE replaces
   * all copies of those keys with the newest copy (ON FALSE: delete by source, insert once).
   */
  private async dedupeTable(ref: DatasetRef, table: string, dateCol: string, keyCols: string[], newestCol: string, range: DateRange): Promise<number> {
    const t = this.fq(ref, table);
    const key = (alias: string) => `TO_JSON_STRING(STRUCT(${keyCols.map((c) => `${alias}${c} AS ${c}`).join(", ")}))`;
    const found = await this.run(
      ref,
      `SELECT ${key("")} AS k, COUNT(*) AS n FROM ${t} WHERE ${dateCol} BETWEEN @from AND @to GROUP BY k HAVING COUNT(*) > 1 LIMIT 10000`,
      { from: range.from, to: range.to },
      { from: "DATE", to: "DATE" },
    );
    if (found.rows.length === 0) return 0;
    const keys = found.rows.map((r) => String(r.k));
    const extra = found.rows.reduce((sum, r) => sum + Number(r.n) - 1, 0);
    await this.run(
      ref,
      `MERGE ${t} T
       USING (SELECT * FROM ${t} WHERE ${dateCol} BETWEEN @from AND @to AND ${key("")} IN UNNEST(@keys)
              QUALIFY ROW_NUMBER() OVER (PARTITION BY ${keyCols.join(", ")} ORDER BY ${newestCol} DESC) = 1) S
       ON FALSE
       WHEN NOT MATCHED BY SOURCE AND T.${dateCol} BETWEEN @from AND @to AND ${key("T.")} IN UNNEST(@keys) THEN DELETE
       WHEN NOT MATCHED THEN INSERT ROW`,
      { from: range.from, to: range.to, keys },
      { from: "DATE", to: "DATE", keys: ["STRING"] },
    );
    return extra;
  }

  async rebuildMart(ref: DatasetRef, range: DateRange): Promise<{ stats: QueryStats }> {
    const res = await this.run(
      ref,
      `BEGIN TRANSACTION;
       DELETE FROM ${this.fq(ref, "mart_daily_source")} WHERE metric_date BETWEEN @from AND @to;
       INSERT INTO ${this.fq(ref, "mart_daily_source")}
       SELECT metric_date, origin, source, currency, is_simulated,
         SUM(impressions), SUM(clicks), SUM(spend), SUM(sessions), SUM(conversions),
         IF(COUNT(DISTINCT conversion_type) = 1, MIN(conversion_type), NULL),
         SUM(leads), SUM(attributed_revenue), SUM(billed_revenue),
         COUNT(*), LOGICAL_OR(data_status = 'preliminary'), CURRENT_TIMESTAMP()
       FROM ${this.fq(ref, "norm_campaign_daily")}
       WHERE metric_date BETWEEN @from AND @to
       GROUP BY metric_date, origin, source, currency, is_simulated;
       COMMIT TRANSACTION;`,
      { from: range.from, to: range.to },
      { from: "DATE", to: "DATE" },
    );
    return { stats: res.stats };
  }

  async queryDaily(ref: DatasetRef, range: DateRange): Promise<{ rows: MartRow[]; stats: QueryStats }> {
    const res = await this.run(
      ref,
      `SELECT FORMAT_DATE('%F', metric_date) AS metric_date, origin, source, currency, is_simulated,
         impressions, clicks, CAST(spend AS FLOAT64) AS spend, sessions, conversions, conversion_type, leads,
         CAST(attributed_revenue AS FLOAT64) AS attributed_revenue, CAST(billed_revenue AS FLOAT64) AS billed_revenue,
         campaign_count, has_preliminary
       FROM ${this.fq(ref, "mart_daily_source")}
       WHERE metric_date BETWEEN @from AND @to
       ORDER BY metric_date, origin, source`,
      { from: range.from, to: range.to },
      { from: "DATE", to: "DATE" },
    );
    return { rows: res.rows.map(numberize) as unknown as MartRow[], stats: res.stats };
  }

  async queryCampaigns(ref: DatasetRef, range: DateRange, limit: number): Promise<{ rows: CampaignRow[]; stats: QueryStats }> {
    const res = await this.run(
      ref,
      `SELECT origin, source, account_id, ANY_VALUE(account_name) AS account_name, campaign_id,
         ANY_VALUE(campaign_name) AS campaign_name, currency, LOGICAL_OR(is_simulated) AS is_simulated,
         SUM(impressions) AS impressions, SUM(clicks) AS clicks, CAST(SUM(spend) AS FLOAT64) AS spend,
         SUM(sessions) AS sessions, SUM(conversions) AS conversions,
         IF(COUNT(DISTINCT conversion_type) = 1, MIN(conversion_type), NULL) AS conversion_type,
         SUM(leads) AS leads, CAST(SUM(attributed_revenue) AS FLOAT64) AS attributed_revenue,
         FORMAT_DATE('%F', MIN(metric_date)) AS first_date, FORMAT_DATE('%F', MAX(metric_date)) AS last_date
       FROM ${this.fq(ref, "norm_campaign_daily")}
       WHERE metric_date BETWEEN @from AND @to
       GROUP BY origin, source, account_id, campaign_id, currency
       ORDER BY spend DESC, clicks DESC, sessions DESC
       LIMIT @limit`,
      { from: range.from, to: range.to, limit },
      { from: "DATE", to: "DATE", limit: "INT64" },
    );
    return { rows: res.rows.map(numberize) as unknown as CampaignRow[], stats: res.stats };
  }

  async coveredDates(ref: DatasetRef, origin: string, range: DateRange): Promise<string[]> {
    const res = await this.run(
      ref,
      `SELECT DISTINCT FORMAT_DATE('%F', metric_date) AS d FROM ${this.fq(ref, "norm_campaign_daily")}
       WHERE origin = @origin AND metric_date BETWEEN @from AND @to ORDER BY d`,
      { origin, from: range.from, to: range.to },
      { origin: "STRING", from: "DATE", to: "DATE" },
    );
    return res.rows.map((r) => String(r.d));
  }
}

function addStats(acc: QueryStats, s: QueryStats): void {
  acc.bytesProcessed = (acc.bytesProcessed ?? 0) + (s.bytesProcessed ?? 0);
  acc.bytesBilled = (acc.bytesBilled ?? 0) + (s.bytesBilled ?? 0);
}

/** BigQuery returns INT64/NUMERIC as objects or strings; convert to JS numbers. */
function numberize(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (v !== null && typeof v === "object" && "value" in (v as object)) out[k] = Number((v as { value: string }).value);
    else if (typeof v === "bigint") out[k] = Number(v);
    else out[k] = v;
  }
  return out;
}
