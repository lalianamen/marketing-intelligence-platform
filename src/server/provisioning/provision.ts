import type { ServerConfig } from "../config";
import type { Queryable } from "../db";
import { getResourceForCompany, selectCloudProject, toDatasetRef } from "../registry/registry";
import { datasetIdForCompany } from "../warehouse/datasetId";
import { CURRENT_SCHEMA_VERSION, type Warehouse, WarehouseError, type WarehouseProvider } from "../warehouse/types";
import type { ClaimedJob } from "../jobs/queue";
import { recordUsage } from "../usage/usage";

// Provisioning: company → isolated dataset. Every step is idempotent so a retry
// after a crash at any point converges to the same single dataset:
//   1. pick project via registry          (re-uses the existing mapping if any)
//   2. record mapping as 'preparing'       (unique per company)
//   3. create dataset                      (409 / exists → adopt only if labels match)
//   4. verify dataset + labels
//   5. create schema (IF NOT EXISTS)
//   6. mark 'ready', bump project dataset_count once

export class ProvisioningError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

export interface ProvisionDeps {
  cfg: ServerConfig;
  getWarehouse: (provider: WarehouseProvider) => Promise<Warehouse>;
}

export async function provisionCompanyDataset(db: Queryable, job: ClaimedJob, deps: ProvisionDeps): Promise<{ datasetId: string; created: boolean }> {
  const provider: WarehouseProvider = deps.cfg.warehouseMode === "bigquery" ? "bigquery" : "local";
  const company = (
    await db.query<{ id: string; workspace_id: string; status: string }>(
      `select id, workspace_id, status from public.companies where id = $1 and workspace_id = $2`,
      [job.company_id, job.workspace_id],
    )
  ).rows[0];
  if (!company) throw new ProvisioningError("company_not_found", "company no longer exists", false);
  if (company.status !== "active") throw new ProvisioningError("company_inactive", "company is archived", false);

  let resource = await getResourceForCompany(db, company.id);
  if (resource?.status === "ready") return { datasetId: resource.dataset_id, created: false };

  if (!resource) {
    if (provider === "bigquery" && !deps.cfg.bigquery.billingApproved) {
      throw new ProvisioningError(
        "billing_not_approved",
        "Real BigQuery mode is configured but BIGQUERY_BILLING_APPROVED is not 'true'. No dataset was created.",
        false,
      );
    }
    const project = await selectCloudProject(db, provider);
    if (!project) {
      throw new ProvisioningError(
        "no_cloud_project",
        provider === "bigquery"
          ? "No active BigQuery project with spare capacity is registered (set BIGQUERY_PROJECT_ID)."
          : "Local warehouse project is not registered yet (start the worker).",
        true,
      );
    }
    const datasetId = datasetIdForCompany(deps.cfg.datasetPrefix, company.id);
    await db.query(
      `insert into public.analytics_resources
         (workspace_id, company_id, provider, cloud_project_id, project_id, dataset_id, location, status, is_simulated)
       values ($1, $2, $3, $4, $5, $6, $7, 'preparing', $8)
       on conflict (company_id) do nothing`,
      [company.workspace_id, company.id, provider, project.id, project.project_id, datasetId, project.location, provider === "local"],
    );
    resource = await getResourceForCompany(db, company.id);
    if (!resource) throw new ProvisioningError("registry_write_failed", "could not record resource mapping", true);
  }

  const ref = toDatasetRef(resource);
  const warehouse = await deps.getWarehouse(resource.provider);
  const labels = { mip_company: company.id, mip_workspace: company.workspace_id, mip_env: deps.cfg.datasetPrefix };

  let created = false;
  try {
    created = (await warehouse.ensureDataset(ref, labels)) === "created";
    const found = await warehouse.getDatasetLabels(ref);
    if (!found) throw new ProvisioningError("dataset_missing_after_create", "dataset not found after creation", true);
    if (found.mip_company !== company.id || found.mip_workspace !== company.workspace_id) {
      // Never adopt a dataset that belongs to another company/workspace.
      throw new ProvisioningError("dataset_owner_mismatch", "existing dataset has labels of a different tenant", false);
    }
    const version = await warehouse.ensureSchema(ref, CURRENT_SCHEMA_VERSION);

    await db.query(
      `with upd as (
         update public.analytics_resources
            set status = 'ready', schema_version = $2, verified_at = now(), updated_at = now()
          where id = $1 and status <> 'ready'
          returning cloud_project_id)
       update public.cloud_projects p set dataset_count = p.dataset_count + 1
         from upd where p.id = upd.cloud_project_id`,
      [resource.id, version],
    );
    await db.query(
      `insert into public.audit_logs (workspace_id, company_id, actor_type, action, target_type, target_id, metadata)
       values ($1, $2, 'worker', 'dataset.ready', 'analytics_resource', $3, $4)`,
      [company.workspace_id, company.id, resource.id, JSON.stringify({ created, provider: resource.provider, simulated: resource.is_simulated })],
    );
    await recordUsage(db, {
      workspaceId: company.workspace_id,
      companyId: company.id,
      kind: "job_run",
      quantity: 1,
      unit: "provisioning_job",
      metadata: { created },
    });
    return { datasetId: resource.dataset_id, created };
  } catch (err) {
    if (err instanceof ProvisioningError) {
      if (!err.retryable) await markResourceFailed(db, resource.id);
      throw err;
    }
    if (err instanceof WarehouseError) {
      if (!err.retryable) await markResourceFailed(db, resource.id);
      throw new ProvisioningError(`warehouse_${err.code}`, err.message, err.retryable);
    }
    throw new ProvisioningError("unexpected", (err as Error).message ?? "unexpected error", true);
  }
}

async function markResourceFailed(db: Queryable, resourceId: string): Promise<void> {
  await db.query(`update public.analytics_resources set status = 'failed', updated_at = now() where id = $1 and status <> 'ready'`, [
    resourceId,
  ]);
}

/**
 * Reconciliation: companies whose dataset is missing or stuck get a job.
 * Covers "job row lost", "resource stuck in preparing" and "failed after fix".
 */
export async function reconcileProvisioning(db: Queryable): Promise<number> {
  const res = await db.query(
    `insert into public.provisioning_jobs (workspace_id, company_id, idempotency_key)
     select c.workspace_id, c.id, 'reconcile:' || c.id::text || ':' || gen_random_uuid()::text
       from public.companies c
       left join public.analytics_resources r on r.company_id = c.id
      where c.status = 'active'
        and (r.id is null or r.status = 'preparing')
        and not exists (select 1 from public.provisioning_jobs j where j.company_id = c.id and j.status in ('queued', 'running'))
        and not exists (select 1 from public.provisioning_jobs j where j.company_id = c.id and j.status in ('failed', 'dead'))
     on conflict do nothing`,
  );
  return res.rowCount ?? 0;
}
