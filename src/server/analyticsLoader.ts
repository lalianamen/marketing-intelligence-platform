import "server-only";
import { loadConfig } from "./config";
import { getPool } from "./db";
import { getDashboardData, resolveRange } from "./metrics/dashboard";
import { getWarehouse } from "./warehouse";

export async function loadAnalytics(userId: string, company: { id: string; timezone: string }, params: { from?: string; to?: string; days?: string }) {
  const cfg = loadConfig();
  const days = params.days ? Math.min(400, Math.max(1, Number(params.days) || 28)) : 28;
  const range = resolveRange({ from: params.from, to: params.to, days }, company.timezone);
  const data = await getDashboardData(getPool(), (p) => getWarehouse(p, cfg), userId, company.id, range);
  return { range, data };
}
