import type { ServerConfig } from "../config";
import type { Queryable } from "../db";
import type { DatasetRef, WarehouseProvider } from "../warehouse/types";

// Resource registry: the ONLY way business logic finds a project/dataset.
// No project ID is hardcoded in domain code; projects are rows in
// cloud_projects and companies map to datasets in analytics_resources.

export interface CloudProjectRow {
  id: string;
  provider: WarehouseProvider;
  project_id: string;
  location: string;
  status: string;
  max_datasets: number;
  dataset_count: number;
  is_default: boolean;
}

export interface AnalyticsResourceRow {
  id: string;
  workspace_id: string;
  company_id: string;
  provider: WarehouseProvider;
  cloud_project_id: string;
  project_id: string;
  dataset_id: string;
  location: string;
  status: "preparing" | "ready" | "failed";
  schema_version: number;
  is_simulated: boolean;
  verified_at: string | null;
}

/**
 * Registers the administrator-configured project for the active warehouse mode.
 * Idempotent; called by the worker on start-up.
 */
export async function ensureConfiguredProject(db: Queryable, cfg: ServerConfig): Promise<CloudProjectRow | null> {
  if (cfg.warehouseMode === "local") {
    const r = await db.query<CloudProjectRow>(
      `insert into public.cloud_projects (provider, project_id, location, max_datasets, is_default)
       values ('local', 'local', 'local', 100000, true)
       on conflict (provider, project_id) do update set is_default = true
       returning *`,
    );
    return r.rows[0] ?? null;
  }
  if (!cfg.bigquery.projectId) return null;
  const r = await db.query<CloudProjectRow>(
    `insert into public.cloud_projects (provider, project_id, location, max_datasets, is_default)
     values ('bigquery', $1, $2, $3, true)
     on conflict (provider, project_id) do update set max_datasets = excluded.max_datasets
     returning *`,
    [cfg.bigquery.projectId, cfg.bigquery.location, cfg.bigquery.datasetsPerProject],
  );
  return r.rows[0] ?? null;
}

/**
 * Project selector. Phase 1: the default active project of the provider with
 * spare capacity. Future: placement by region, tier, quota pressure, or a
 * dedicated project per large workspace — without changing callers.
 */
export async function selectCloudProject(db: Queryable, provider: WarehouseProvider): Promise<CloudProjectRow | null> {
  const r = await db.query<CloudProjectRow>(
    `select * from public.cloud_projects
      where provider = $1 and status = 'active' and dataset_count < max_datasets
      order by is_default desc, dataset_count asc
      limit 1`,
    [provider],
  );
  return r.rows[0] ?? null;
}

export async function getResourceForCompany(db: Queryable, companyId: string): Promise<AnalyticsResourceRow | null> {
  const r = await db.query<AnalyticsResourceRow>(`select * from public.analytics_resources where company_id = $1`, [companyId]);
  return r.rows[0] ?? null;
}

export function toDatasetRef(r: Pick<AnalyticsResourceRow, "provider" | "project_id" | "dataset_id" | "location">): DatasetRef {
  return { provider: r.provider, projectId: r.project_id, datasetId: r.dataset_id, location: r.location };
}
