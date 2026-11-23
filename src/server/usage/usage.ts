import type { Queryable } from "../db";

// Usage instrumentation. Estimates are ALWAYS stored with is_estimate = true and
// labelled as estimates in the UI. Actual billed cost can only come from Cloud
// Billing export reconciliation (documented in docs/COSTS.md; not built yet).

export type UsageKind = "warehouse_query" | "warehouse_rows_written" | "provider_api_call" | "job_run" | "storage_snapshot";

export interface UsageInput {
  workspaceId: string;
  companyId?: string | null;
  kind: UsageKind;
  quantity: number;
  unit: string;
  bytesProcessed?: number | null;
  bytesBilled?: number | null;
  metadata?: Record<string, unknown>;
}

/** On-demand price used ONLY for estimates; verify on the official pricing page (docs/SOURCES.md). */
export const ON_DEMAND_USD_PER_TIB = 6.25;
const TIB = 1024 ** 4;

export function estimateQueryCostUsd(bytesBilled: number | null | undefined): number | null {
  if (bytesBilled === null || bytesBilled === undefined) return null;
  // Gross list price; the monthly free tier is shared at billing-account level,
  // so per-tenant free allowance cannot be attributed and is not subtracted.
  return Number(((bytesBilled / TIB) * ON_DEMAND_USD_PER_TIB).toFixed(6));
}

export async function recordUsage(db: Queryable, u: UsageInput): Promise<void> {
  await db.query(
    `insert into public.usage_events (workspace_id, company_id, kind, quantity, unit, bytes_processed, bytes_billed, estimated_cost_usd, is_estimate, metadata)
     values ($1, $2, $3, $4, $5, $6, $7, $8, true, $9)`,
    [
      u.workspaceId,
      u.companyId ?? null,
      u.kind,
      u.quantity,
      u.unit,
      u.bytesProcessed ?? null,
      u.bytesBilled ?? null,
      estimateQueryCostUsd(u.bytesBilled),
      JSON.stringify(u.metadata ?? {}),
    ],
  );
}
