import { addDays, daysBetweenInclusive, isValidDate, localDate, previousPeriod } from "../../lib/dates";
import { type PeriodSummary, summarizePeriod } from "../../lib/kpi";
import type { CampaignRow, MartRow } from "../../lib/model";
import { requireCompanyAccess } from "../auth/authz";
import type { Queryable } from "../db";
import { getResourceForCompany, toDatasetRef } from "../registry/registry";
import { recordUsage } from "../usage/usage";
import { MAX_RANGE_DAYS, type Warehouse, type WarehouseProvider } from "../warehouse/types";

// Dashboard query service. Resolves the dataset ONLY through the registry for
// a company the user is authorized to read; reads only the pre-aggregated mart
// (plus a bounded campaign query) for a bounded date range.

export interface DashboardRange {
  from: string;
  to: string;
}

export function resolveRange(input: { from?: string | null; to?: string | null; days?: number | null }, timezone: string, now = new Date()): DashboardRange {
  const yesterday = addDays(localDate(now, timezone), -1);
  let to = input.to && isValidDate(input.to) ? input.to : yesterday;
  let from = input.from && isValidDate(input.from) ? input.from : addDays(to, -((input.days ?? 28) - 1));
  if (from > to) [from, to] = [to, from];
  if (daysBetweenInclusive(from, to) > MAX_RANGE_DAYS) from = addDays(to, -(MAX_RANGE_DAYS - 1));
  return { from, to };
}

export interface DashboardData {
  status: "ready" | "no_dataset" | "preparing" | "failed";
  isSimulatedWarehouse: boolean;
  current: PeriodSummary | null;
  previous: PeriodSummary | null;
  campaigns: CampaignRow[];
  dailyRows: MartRow[];
}

export async function getDashboardData(
  db: Queryable,
  getWarehouse: (p: WarehouseProvider) => Promise<Warehouse>,
  userId: string,
  companyId: string,
  range: DashboardRange,
): Promise<DashboardData> {
  const { workspaceId } = await requireCompanyAccess(db, userId, companyId, "read");
  const resource = await getResourceForCompany(db, companyId);
  const empty = { current: null, previous: null, campaigns: [], dailyRows: [] };
  if (!resource) return { status: "no_dataset", isSimulatedWarehouse: false, ...empty };
  if (resource.status !== "ready") return { status: resource.status, isSimulatedWarehouse: resource.is_simulated, ...empty };
  if (resource.company_id !== companyId || resource.workspace_id !== workspaceId) throw new Error("registry tenant mismatch");

  const wh = await getWarehouse(resource.provider);
  const ref = toDatasetRef(resource);
  const prev = previousPeriod(range.from, range.to);
  const [cur, old, camps] = await Promise.all([
    wh.queryDaily(ref, range),
    wh.queryDaily(ref, prev),
    wh.queryCampaigns(ref, range, 200),
  ]);
  const bytes = [cur.stats, old.stats, camps.stats].reduce(
    (a, s) => ({ p: a.p + (s.bytesProcessed ?? 0), b: a.b + (s.bytesBilled ?? 0), known: a.known || s.bytesProcessed !== null }),
    { p: 0, b: 0, known: false },
  );
  await recordUsage(db, {
    workspaceId,
    companyId,
    kind: "warehouse_query",
    quantity: 3,
    unit: "queries",
    bytesProcessed: bytes.known ? bytes.p : null,
    bytesBilled: bytes.known ? bytes.b : null,
    metadata: { purpose: "dashboard", warehouse: resource.provider, days: daysBetweenInclusive(range.from, range.to) },
  });
  return {
    status: "ready",
    isSimulatedWarehouse: resource.is_simulated,
    current: summarizePeriod(cur.rows, range),
    previous: summarizePeriod(old.rows, prev),
    campaigns: camps.rows,
    dailyRows: cur.rows,
  };
}
