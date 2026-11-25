import type { BigQuery } from "@google-cloud/bigquery";
import type { CampaignRow, MartRow, NormalizedRow, RawRecord } from "../../lib/model";
import { assertSafeIdentifier, assertSafeProjectId } from "./datasetId";
import {
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
        params,
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
      // MERGE on record_id keeps RAW idempotent when a run is retried.
      const res = await this.run(
        ref,
        `MERGE ${this.fq(ref, "raw_records")} T
         USING (SELECT * FROM UNNEST(@rows)) S
         ON T.record_id = S.record_id AND T.record_date BETWEEN @min_date AND @max_date
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
