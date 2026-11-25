import type { Queryable } from "../db";
import { getResourceForCompany, toDatasetRef } from "../registry/registry";
import { WarehouseError } from "../warehouse/types";
import type { ClaimedJob } from "../jobs/queue";
import { ProvisioningError, type ProvisionDeps } from "./provision";

// Company deletion, worker side (the delete_company RPC already stopped all
// work and marked the company 'deleting'). Every step is idempotent, so a
// retry after a crash converges:
//   1. wait while a sync is still running for the company (retry later)
//   2. verify the dataset labels name THIS company (never drop another tenant's data)
//   3. drop the dataset (already gone → fine)
//   4. delete the registry row, decrement the project's dataset count
//   5. write the audit entry, then delete the company row (cascades)

export async function deleteCompanyDataset(db: Queryable, job: ClaimedJob, deps: ProvisionDeps): Promise<{ dropped: boolean }> {
  const company = (
    await db.query<{ id: string; workspace_id: string; status: string; name: string }>(
      `select id, workspace_id, status, name from public.companies where id = $1 and workspace_id = $2`,
      [job.company_id, job.workspace_id],
    )
  ).rows[0];
  if (!company) return { dropped: false }; // already deleted
  if (company.status !== "deleting") throw new ProvisioningError("company_not_deleting", "company is not marked for deletion", false);

  const running = await db.query(`select 1 from public.sync_runs where company_id = $1 and status = 'running' limit 1`, [company.id]);
  if (running.rowCount) throw new ProvisioningError("company_busy", "a sync is still running for this company", true);

  let dropped = false;
  const resource = await getResourceForCompany(db, company.id);
  if (resource) {
    const ref = toDatasetRef(resource);
    try {
      const warehouse = await deps.getWarehouse(resource.provider);
      const labels = await warehouse.getDatasetLabels(ref);
      if (labels) {
        if (labels.mip_company !== company.id || labels.mip_workspace !== company.workspace_id) {
          throw new ProvisioningError("dataset_owner_mismatch", "dataset labels name a different tenant; refusing to delete", false);
        }
        dropped = (await warehouse.deleteDataset(ref)) === "deleted";
      }
    } catch (err) {
      if (err instanceof ProvisioningError) throw err;
      if (err instanceof WarehouseError) throw new ProvisioningError(`warehouse_${err.code}`, err.message, err.retryable);
      throw new ProvisioningError("unexpected", (err as Error).message ?? "unexpected error", true);
    }
    await db.query(
      `with del as (delete from public.analytics_resources where id = $1 returning cloud_project_id, status)
       update public.cloud_projects p set dataset_count = greatest(p.dataset_count - 1, 0)
         from del where p.id = del.cloud_project_id and del.status = 'ready'`,
      [resource.id],
    );
  }

  await db.query(
    `insert into public.audit_logs (workspace_id, company_id, actor_type, action, target_type, target_id, metadata)
     values ($1, $2::uuid, 'worker', 'company.deleted', 'company', $2::text, $3)`,
    [company.workspace_id, company.id, JSON.stringify({ name: company.name, dataset_dropped: dropped, provider: resource?.provider ?? null })],
  );
  // Cascades to settings, connections, secrets, schedules, uploads, runs, jobs (including this one).
  await db.query(`delete from public.companies where id = $1 and status = 'deleting'`, [company.id]);
  return { dropped };
}

/** Companies stuck in 'deleting' without an active deletion job get one (e.g. the job went dead after an outage). */
export async function reconcileDeletions(db: Queryable): Promise<number> {
  const res = await db.query(
    `insert into public.provisioning_jobs (workspace_id, company_id, kind, idempotency_key)
     select c.workspace_id, c.id, 'delete_dataset', 'delete_dataset:' || c.id::text || ':reconcile:' || gen_random_uuid()::text
       from public.companies c
      where c.status = 'deleting'
        and c.deletion_requested_at < now() - interval '10 minutes'
        and not exists (select 1 from public.provisioning_jobs j where j.company_id = c.id and j.status in ('queued', 'running'))
        and not exists (select 1 from public.provisioning_jobs j
                         where j.company_id = c.id and j.kind = 'delete_dataset' and j.last_error_code = 'dataset_owner_mismatch')
     on conflict do nothing`,
  );
  return res.rowCount ?? 0;
}

/** Worker side of "Clear all data": empty the company's warehouse tables, keep the dataset. */
export async function clearCompanyData(db: Queryable, job: ClaimedJob, deps: ProvisionDeps): Promise<void> {
  const company = (
    await db.query<{ id: string; workspace_id: string; status: string }>(
      `select id, workspace_id, status from public.companies where id = $1 and workspace_id = $2`,
      [job.company_id, job.workspace_id],
    )
  ).rows[0];
  if (!company || company.status !== "active") return;
  const resource = await getResourceForCompany(db, company.id);
  if (!resource) return;
  const ref = toDatasetRef(resource);
  try {
    const warehouse = await deps.getWarehouse(resource.provider);
    const labels = await warehouse.getDatasetLabels(ref);
    if (!labels) return;
    if (labels.mip_company !== company.id || labels.mip_workspace !== company.workspace_id) {
      throw new ProvisioningError("dataset_owner_mismatch", "dataset labels name a different tenant; refusing to clear", false);
    }
    await warehouse.clearData(ref);
  } catch (err) {
    if (err instanceof ProvisioningError) throw err;
    if (err instanceof WarehouseError) throw new ProvisioningError(`warehouse_${err.code}`, err.message, err.retryable);
    throw new ProvisioningError("unexpected", (err as Error).message ?? "unexpected error", true);
  }
  await db.query(
    `insert into public.audit_logs (workspace_id, company_id, actor_type, action, target_type, target_id, metadata)
     values ($1, $2::uuid, 'worker', 'company.data_cleared', 'company', $2::text, $3)`,
    [company.workspace_id, company.id, JSON.stringify({ provider: resource.provider })],
  );
}
