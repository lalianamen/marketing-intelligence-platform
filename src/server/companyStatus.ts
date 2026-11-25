import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

export type DataSpaceStatus = "pending" | "preparing" | "ready" | "failed";

export interface ConnectionRow {
  id: string;
  provider_id: string;
  mode: "live" | "simulated" | "manual";
  status: string;
  external_account_name: string | null;
  last_synced_at: string | null;
  data_as_of: string | null;
  last_error: string | null;
  /** null while the connector is still being set up (nothing loads yet). */
  activated_at: string | null;
}

export interface SyncRunRow {
  id: string;
  connection_id: string;
  provider_id: string;
  trigger: string;
  status: string;
  window_start: string | null;
  window_end: string | null;
  rows_written: number;
  attempts: number;
  error_code: string | null;
  error_message: string | null;
  is_simulated: boolean;
  created_at: string;
  finished_at: string | null;
  run_after: string;
}

/** Plain-language data space status from the job + registry rows (RLS-scoped reads). */
export async function dataSpaceStatus(supabase: SupabaseClient, companyIds: string[]): Promise<Record<string, { status: DataSpaceStatus; simulated: boolean; error: string | null }>> {
  if (companyIds.length === 0) return {};
  const [{ data: resources }, { data: jobs }] = await Promise.all([
    supabase.from("analytics_resources").select("company_id,status,is_simulated").in("company_id", companyIds),
    supabase.from("provisioning_jobs").select("company_id,status,last_error_code,created_at").in("company_id", companyIds).order("created_at", { ascending: false }),
  ]);
  const out: Record<string, { status: DataSpaceStatus; simulated: boolean; error: string | null }> = {};
  for (const id of companyIds) {
    const r = resources?.find((x) => x.company_id === id);
    const j = jobs?.find((x) => x.company_id === id);
    let status: DataSpaceStatus = "pending";
    if (r?.status === "ready") status = "ready";
    else if (j && (j.status === "failed" || j.status === "dead")) status = "failed";
    else if (j?.status === "running" || r?.status === "preparing") status = "preparing";
    else if (r?.status === "failed") status = "failed";
    out[id] = { status, simulated: r?.is_simulated ?? false, error: status === "failed" ? (j?.last_error_code ?? "failed") : null };
  }
  return out;
}

export async function loadConnections(supabase: SupabaseClient, companyId: string) {
  const [{ data: connections }, { data: runs }, { data: issues }] = await Promise.all([
    supabase
      .from("company_connections")
      .select("id,provider_id,mode,status,external_account_name,last_synced_at,data_as_of,last_error,activated_at")
      .eq("company_id", companyId)
      .neq("status", "disconnected")
      .order("created_at"),
    supabase
      .from("sync_runs")
      .select("id,connection_id,provider_id,trigger,status,window_start,window_end,rows_written,attempts,error_code,error_message,is_simulated,created_at,finished_at,run_after")
      .eq("company_id", companyId)
      .order("created_at", { ascending: false })
      .limit(15),
    supabase
      .from("data_quality_issues")
      .select("id,severity,code,message,metric_date,created_at")
      .eq("company_id", companyId)
      .is("resolved_at", null)
      .order("created_at", { ascending: false })
      .limit(20),
  ]);
  return {
    connections: (connections ?? []) as ConnectionRow[],
    runs: (runs ?? []) as SyncRunRow[],
    issues: (issues ?? []) as { id: string; severity: string; code: string; message: string; metric_date: string | null; created_at: string }[],
  };
}

export const PROVIDER_LABEL: Record<string, string> = {
  csv: "CSV import",
  ga4: "Google Analytics 4",
  google_ads: "Google Ads",
  google_search_console: "Google Search Console",
  microsoft_clarity: "Microsoft Clarity",
  stripe: "Stripe",
};

export function modeBadge(mode: string): { tone: "green" | "amber" | "blue"; text: string } {
  if (mode === "live") return { tone: "green", text: "LIVE" };
  if (mode === "simulated") return { tone: "amber", text: "SIMULATED" };
  return { tone: "blue", text: "MANUAL UPLOAD" };
}
