import type { CampaignRow, MartRow, NormalizedRow, RawRecord } from "../../lib/model";

export type WarehouseProvider = "bigquery" | "local";

/** Resolved ONLY from the analytics_resources registry, never from user input. */
export interface DatasetRef {
  provider: WarehouseProvider;
  projectId: string;
  datasetId: string;
  location: string;
}

export interface DatasetLabels {
  mip_company: string;
  mip_workspace: string;
  mip_env: string;
}

export interface QueryStats {
  bytesProcessed: number | null;
  bytesBilled: number | null;
}

export interface DateRange {
  from: string; // inclusive YYYY-MM-DD
  to: string; // inclusive YYYY-MM-DD
}

/** A JSON path into payload_json: field names and array indexes only (validated). */
export type RawPath = string[];

export interface RawPageQuery {
  syncRunIds: string[];
  source?: string;
  from?: string;
  to?: string;
  filters?: { path: RawPath; op: "contains" | "eq" | "gt" | "lt"; value: string }[];
  sort?: { by: "record_date" | "ingested_at" | RawPath; dir: "asc" | "desc" };
  limit: number;
  offset: number;
}

const SEGMENT = /^[A-Za-z0-9_]{1,64}$/;
export function assertRawPath(path: RawPath): RawPath {
  if (path.length === 0 || path.length > 4 || !path.every((p) => SEGMENT.test(p))) {
    throw new WarehouseError("invalid", "invalid raw column");
  }
  return path;
}

export interface Warehouse {
  readonly provider: WarehouseProvider;
  /** true when this is NOT a real BigQuery dataset (local simulated warehouse). */
  readonly isSimulated: boolean;
  ensureDataset(ref: DatasetRef, labels: DatasetLabels): Promise<"created" | "exists">;
  getDatasetLabels(ref: DatasetRef): Promise<Partial<DatasetLabels> | null>;
  /** Drops the dataset and all its tables. Returns 'not_found' if it is already gone. Callers must verify labels first. */
  deleteDataset(ref: DatasetRef): Promise<"deleted" | "not_found">;
  /** Raw provider records of the given sync runs (identical payloads shown once), newest day first. */
  queryRaw(ref: DatasetRef, syncRunIds: string[], limit: number, source?: string): Promise<{ rows: RawRecord[]; stats: QueryStats }>;
  /** Raw rows with period, column filters, sorting and paging; `total` counts all matching rows. */
  queryRawPage(ref: DatasetRef, q: RawPageQuery): Promise<{ rows: RawRecord[]; total: number; stats: QueryStats }>;
  /**
   * Deletes one connection's data: normalized rows matching origin / simulation flag / account (when given)
   * and raw rows of its sync runs. Returns the affected date range so the caller can rebuild the mart.
   */
  deleteConnectionData(
    ref: DatasetRef,
    scope: { origin: string; isSimulated: boolean; accountId: string | null; syncRunIds: string[]; range?: DateRange; rawSources?: string[]; skipNormalized?: boolean },
  ): Promise<{ range: DateRange | null }>;
  /** Empties the data tables (raw, normalized, mart) and keeps the dataset and schema. */
  clearData(ref: DatasetRef): Promise<void>;
  ensureSchema(ref: DatasetRef, version: number): Promise<number>;
  insertRaw(ref: DatasetRef, rows: RawRecord[]): Promise<{ written: number; stats: QueryStats }>;
  upsertNormalized(ref: DatasetRef, rows: NormalizedRow[]): Promise<{ written: number; stats: QueryStats }>;
  rebuildMart(ref: DatasetRef, range: DateRange): Promise<{ stats: QueryStats }>;
  queryDaily(ref: DatasetRef, range: DateRange): Promise<{ rows: MartRow[]; stats: QueryStats }>;
  queryCampaigns(ref: DatasetRef, range: DateRange, limit: number): Promise<{ rows: CampaignRow[]; stats: QueryStats }>;
  /** Dates (YYYY-MM-DD) that have at least one normalized row for an origin in the range. */
  coveredDates(ref: DatasetRef, origin: string, range: DateRange): Promise<string[]>;
}

export type WarehouseErrorCode =
  | "timeout"
  | "quota_exceeded"
  | "rate_limited"
  | "unavailable"
  | "permission_denied"
  | "not_found"
  | "already_exists"
  | "invalid"
  | "bytes_limit_exceeded"
  | "unknown";

const RETRYABLE: ReadonlySet<WarehouseErrorCode> = new Set(["timeout", "quota_exceeded", "rate_limited", "unavailable"]);

export class WarehouseError extends Error {
  readonly code: WarehouseErrorCode;
  readonly retryable: boolean;
  constructor(code: WarehouseErrorCode, message: string) {
    super(message);
    this.name = "WarehouseError";
    this.code = code;
    this.retryable = RETRYABLE.has(code);
  }
}

/** Hard cap on dashboard date ranges (bounded queries). */
export const MAX_RANGE_DAYS = 400;

export const CURRENT_SCHEMA_VERSION = 1;
