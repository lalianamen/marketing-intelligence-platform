"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getUser } from "@/server/supabase/server";
import { getPool } from "@/server/db";
import { COMPANY_COOKIE } from "@/server/appContext";
import { storeValidatedUpload } from "@/server/ingestion/uploads";
import { AccessDeniedError } from "@/server/auth/authz";
import { CSV_LIMITS } from "@/server/ingestion/csv";
import { BUSINESS_TYPES } from "@/lib/businessTypes";
import { kickJobs } from "@/server/jobs/kick";
import { loadConfig } from "@/server/config";
import { getCompanyAccess } from "@/server/auth/authz";
import { decryptSecret } from "@/server/crypto";
import { withTransaction } from "@/server/db";
import { createLiveConnection, type GoogleProvider } from "@/server/oauth/connect";
import { clearConnectorForReload, deleteConnection, setGa4Report, updateSchedule } from "@/server/connections/manage";
import { localDate, addDays } from "@/lib/dates";
import { getWarehouse } from "@/server/warehouse";
import type { DiscoveredAccount } from "@/server/connectors/google";

// Server actions. Each action authenticates the user; writes go through
// RLS-checked RPCs (user client) or, for CSV intake, through server-side
// authorization + validation before the privileged insert.

async function requireUser() {
  const { supabase, user } = await getUser();
  if (!user) redirect("/login");
  return { supabase, user };
}

function friendly(message: string | undefined): string {
  if (!message) return "Something went wrong. Please try again.";
  if (/rate limit/i.test(message)) return "You are doing that too often. Please wait a little and try again.";
  if (/company limit/i.test(message)) return "This workspace has reached its company limit.";
  if (/invalid timezone/i.test(message)) return "Please choose a valid time zone.";
  if (/invalid business type/i.test(message)) return "Please choose a business type.";
  if (/not found/i.test(message)) return "Not found, or you do not have access.";
  if (/already provisioned/i.test(message)) return "This company's data space is already ready.";
  if (/disconnected/i.test(message)) return "This connection is disconnected.";
  if (/confirmation name/i.test(message)) return "The name you typed does not match the company name. Nothing was deleted.";
  if (/history can be loaded only/i.test(message)) return "History can be loaded only for connected sources.";
  if (/company busy/i.test(message)) return "The company is busy (its data space is being prepared or an import is running). Try again in a minute.";
  return "Something went wrong. Please try again.";
}

export async function createCompanyAction(form: FormData): Promise<void> {
  const { supabase } = await requireUser();
  const name = String(form.get("name") ?? "").trim();
  if (!name) redirect("/app/companies/new?error=" + encodeURIComponent("Company name is required."));
  const website = String(form.get("website") ?? "").trim();
  if (website && !/^(https?:\/\/)?[\w.-]+\.[a-z]{2,}(\/.*)?$/i.test(website))
    redirect("/app/companies/new?error=" + encodeURIComponent("Website does not look like a web address."));
  const r = await supabase.rpc("create_company", {
    p_workspace_id: String(form.get("workspace_id") ?? ""),
    p_name: name.slice(0, 160),
    p_website: website || null,
    p_industry: String(form.get("industry") ?? "").trim() || null,
    p_country: String(form.get("country") ?? "").trim().toUpperCase().slice(0, 2) || null,
    p_timezone: String(form.get("timezone") ?? "UTC"),
    p_business_type: String(form.get("business_type") ?? "other"),
  });
  if (r.error) redirect("/app/companies/new?error=" + encodeURIComponent(friendly(r.error.message)));
  (await cookies()).set(COMPANY_COOKIE, r.data as string, { httpOnly: true, sameSite: "lax", path: "/" });
  kickJobs();
  redirect(`/app/companies?created=${r.data}`);
}

export async function retryProvisioningAction(form: FormData): Promise<void> {
  const { supabase } = await requireUser();
  const r = await supabase.rpc("retry_provisioning", { p_company_id: String(form.get("company_id") ?? "") });
  if (r.error) redirect("/app/companies?error=" + encodeURIComponent(friendly(r.error.message)));
  revalidatePath("/app/companies");
  kickJobs();
  redirect("/app/companies");
}

export async function enableSampleConnectionAction(form: FormData): Promise<void> {
  const { supabase } = await requireUser();
  const r = await supabase.rpc("enable_simulated_connection", {
    p_company_id: String(form.get("company_id") ?? ""),
    p_provider_id: String(form.get("provider_id") ?? ""),
  });
  if (r.error) redirect("/app/connections?error=" + encodeURIComponent(friendly(r.error.message)));
  await supabase.rpc("request_sync", { p_connection_id: r.data });
  kickJobs();
  redirect("/app/connections?sample=1");
}

export async function syncNowAction(form: FormData): Promise<void> {
  const { supabase } = await requireUser();
  const id = String(form.get("connection_id") ?? "");
  const backRaw = String(form.get("back") ?? "");
  const back = /^\/app\/connections\/[0-9a-f-]{36}$/i.test(backRaw) ? backRaw : "/app/connections";
  const r = await supabase.rpc("request_sync", { p_connection_id: id });
  if (r.error) redirect(`${back}?error=` + encodeURIComponent(friendly(r.error.message)));
  kickJobs();
  redirect(`${back}?queued=1`);
}

export async function disconnectAction(form: FormData): Promise<void> {
  const { supabase } = await requireUser();
  const r = await supabase.rpc("disconnect_connection", { p_connection_id: String(form.get("connection_id") ?? "") });
  if (r.error) redirect("/app/connections?error=" + encodeURIComponent(friendly(r.error.message)));
  redirect("/app/connections");
}

export async function renameWorkspaceAction(form: FormData): Promise<void> {
  const { supabase } = await requireUser();
  const name = String(form.get("name") ?? "").trim().slice(0, 120);
  if (name) await supabase.from("workspaces").update({ name }).eq("id", String(form.get("workspace_id") ?? ""));
  redirect("/app/account?saved=1");
}

export async function updateCompanyAction(form: FormData): Promise<void> {
  const { supabase } = await requireUser();
  const id = String(form.get("company_id") ?? "");
  const name = String(form.get("name") ?? "").trim().slice(0, 160);
  const businessType = String(form.get("business_type") ?? "");
  const patch: Record<string, string> = {};
  if (name) patch.name = name;
  if ((BUSINESS_TYPES as readonly string[]).includes(businessType)) patch.business_type = businessType;
  if (Object.keys(patch).length) await supabase.from("companies").update(patch).eq("id", id);
  redirect("/app/settings?saved=1");
}

export interface CsvPreviewState {
  status: "idle" | "invalid" | "ready" | "duplicate";
  uploadId?: string;
  filename?: string;
  errors?: { row: number | null; column: string | null; message: string }[];
  warnings?: { row: number | null; column: string | null; message: string }[];
  summary?: {
    rowCount: number;
    dateFrom: string | null;
    dateTo: string | null;
    sources: string[];
    currencies: string[];
    columnsPresent: string[];
    totals: Record<string, number>;
  };
  preview?: string[][];
  message?: string;
}

export async function uploadCsvAction(_prev: CsvPreviewState, form: FormData): Promise<CsvPreviewState> {
  const { user } = await requireUser();
  const companyId = String(form.get("company_id") ?? "");
  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) return { status: "invalid", message: "Choose a CSV file first." };
  if (file.size > CSV_LIMITS.maxBytes) return { status: "invalid", message: "The file is larger than 5 MB." };
  if (!/\.csv$/i.test(file.name) && file.type !== "text/csv") return { status: "invalid", message: "Only .csv files are supported." };
  const text = await file.text();
  try {
    const res = await storeValidatedUpload(getPool(), { userId: user.id, companyId, filename: file.name, text, byteSize: file.size });
    const preview = text.replace(/^﻿/, "").split(/\r?\n/).slice(0, 11).map((l) => l.split(",").slice(0, 15));
    if (!res.uploadId) {
      return { status: "invalid", filename: file.name, errors: res.validation.errors, warnings: res.validation.warnings, summary: res.validation.summary as CsvPreviewState["summary"], preview };
    }
    return {
      status: res.duplicateOf ? "duplicate" : "ready",
      uploadId: res.uploadId,
      filename: file.name,
      errors: [],
      warnings: res.validation.warnings,
      summary: res.validation.summary as CsvPreviewState["summary"],
      preview,
    };
  } catch (err) {
    if (err instanceof AccessDeniedError) return { status: "invalid", message: "You do not have permission to add data to this company." };
    return { status: "invalid", message: "The file could not be processed." };
  }
}

export async function confirmCsvImportAction(form: FormData): Promise<void> {
  const { supabase } = await requireUser();
  const r = await supabase.rpc("queue_csv_import", { p_upload_id: String(form.get("upload_id") ?? "") });
  if (r.error) redirect("/app/connections/csv?error=" + encodeURIComponent(friendly(r.error.message)));
  kickJobs();
  redirect("/app/connections?imported=1");
}

export async function deleteCompanyAction(form: FormData): Promise<void> {
  const { supabase } = await requireUser();
  const companyId = String(form.get("company_id") ?? "");
  const r = await supabase.rpc("delete_company", {
    p_company_id: companyId,
    p_confirm_name: String(form.get("confirm_name") ?? "").slice(0, 200),
  });
  if (r.error) redirect("/app/settings?error=" + encodeURIComponent(friendly(r.error.message)));
  const store = await cookies();
  if (store.get(COMPANY_COOKIE)?.value === companyId) store.delete(COMPANY_COOKIE);
  revalidatePath("/app", "layout");
  kickJobs();
  redirect("/app/companies?deleted=1");
}

export async function chooseGoogleAccountsAction(form: FormData): Promise<void> {
  const { user } = await requireUser();
  const grantId = String(form.get("grant") ?? "");
  const picked = form.getAll("account").map(String).slice(0, 50);
  const back = (msg: string) => redirect("/app/connections?oauth=" + encodeURIComponent(msg));
  if (!/^[0-9a-f-]{36}$/i.test(grantId)) back("This connection attempt expired. Please try again.");
  if (picked.length === 0) redirect(`/app/connections/choose?grant=${grantId}&error=1`);
  const cfg = loadConfig();
  const db = getPool();
  const g = (
    await db.query<{ id: string; workspace_id: string; company_id: string; provider_id: GoogleProvider; ciphertext: string; scopes: string[]; accounts: DiscoveredAccount[] }>(
      `delete from public.oauth_pending_grants where id = $1 and user_id = $2 and expires_at > now() returning *`,
      [grantId, user.id],
    )
  ).rows[0];
  if (!g) back("This connection attempt expired. Please try again.");
  const grant = g!;
  if ((await getCompanyAccess(db, user.id, grant.company_id)) !== "manage") back("Not found, or you do not have access.");
  const chosen = grant.accounts.filter((a) => picked.includes(a.id));
  if (chosen.length === 0) back("Please choose at least one account.");
  const refreshToken = decryptSecret(grant.ciphertext, cfg.tokenEncryptionKey!, `pending:${grant.id}`);
  const ids = await withTransaction(async (c) => {
    const out: string[] = [];
    for (const account of chosen) {
      out.push(
        await createLiveConnection(c, {
          workspaceId: grant.workspace_id,
          companyId: grant.company_id,
          userId: user.id,
          provider: grant.provider_id,
          account,
          refreshToken,
          scopes: grant.scopes,
          encryptionKey: cfg.tokenEncryptionKey!,
        }),
      );
    }
    return out;
  }, db);
  // Nothing loads yet: each new connector is set up first (data, period, schedule).
  if (ids.length === 1) redirect(`/app/connections/${ids[0]}?setup=1`);
  redirect(`/app/connections?connected=${encodeURIComponent(chosen.map((a) => a.name).join(", "))}`);
}

export async function clearCompanyDataAction(form: FormData): Promise<void> {
  const { supabase } = await requireUser();
  const r = await supabase.rpc("clear_company_data", {
    p_company_id: String(form.get("company_id") ?? ""),
    p_confirm_name: String(form.get("confirm_name") ?? "").slice(0, 200),
  });
  if (r.error) redirect("/app/settings?error=" + encodeURIComponent(friendly(r.error.message)));
  revalidatePath("/app", "layout");
  kickJobs();
  redirect("/app/settings?cleared=1");
}

export async function updateScheduleAction(form: FormData): Promise<void> {
  const { user } = await requireUser();
  const id = String(form.get("connection_id") ?? "");
  try {
    await updateSchedule(getPool(), user.id, id, {
      frequency: String(form.get("frequency") ?? ""),
      localTime: String(form.get("local_time") ?? "").slice(0, 5),
    });
  } catch (err) {
    const m = (err as Error).message;
    redirect(`/app/connections/${id}?error=` + encodeURIComponent(/invalid time/.test(m) ? "Please choose a valid time." : friendly(m)));
  }
  redirect(`/app/connections/${id}?saved=1#schedule`);
}

export async function disconnectConnectionAction(form: FormData): Promise<void> {
  const { supabase } = await requireUser();
  const id = String(form.get("connection_id") ?? "");
  const r = await supabase.rpc("disconnect_connection", { p_connection_id: id });
  if (r.error) redirect(`/app/connections/${id}?error=` + encodeURIComponent(friendly(r.error.message)));
  redirect("/app/connections");
}

export async function deleteConnectionAction(form: FormData): Promise<void> {
  const { user } = await requireUser();
  const id = String(form.get("connection_id") ?? "");
  const cfg = loadConfig();
  let name = "";
  try {
    ({ name } = await deleteConnection(getPool(), (p) => getWarehouse(p, cfg), user.id, id));
  } catch (err) {
    const m = (err as Error).message;
    redirect(`/app/connections/${id}?error=` + encodeURIComponent(/busy/.test(m) ? "An update is running right now. Try again in a minute." : friendly(m)));
  }
  revalidatePath("/app", "layout");
  redirect("/app/connections?deleted=" + encodeURIComponent(name));
}

export async function toggleGa4ReportAction(form: FormData): Promise<void> {
  const { supabase, user } = await requireUser();
  const id = String(form.get("connection_id") ?? "");
  const report = String(form.get("report") ?? "");
  const on = String(form.get("on") ?? "") === "true";
  const cfg = loadConfig();
  const db = getPool();
  const conn = (await db.query<{ activated_at: Date | null; timezone: string }>(
    `select c.activated_at, co.timezone from public.company_connections c join public.companies co on co.id = c.company_id where c.id = $1`,
    [id],
  )).rows[0];
  const back = (msg: string) => redirect(`/app/connections/${id}?error=` + encodeURIComponent(msg) + "#ga4-reports");
  try {
    await setGa4Report(db, (p) => getWarehouse(p, cfg), user.id, id, report, on);
  } catch (err) {
    const m = (err as Error).message;
    back(/GA4 allows/.test(m) ? m : friendly(m));
  }
  if (!conn?.activated_at) {
    // Still in setup: just remember the choice; nothing is loaded yet.
    redirect(`/app/connections/${id}?setup=1#ga4-reports`);
  }
  // After the first load, a change of the collected data restarts the connector:
  // its tables are deleted and the same period is loaded again with the new set.
  const yesterday = addDays(localDate(new Date(), conn!.timezone), -1);
  let period: { from: string; to: string };
  try {
    period = await clearConnectorForReload(db, (p) => getWarehouse(p, cfg), user.id, id, yesterday);
  } catch (err) {
    back(/busy/.test((err as Error).message) ? "A load is running right now. Try again in a minute." : friendly((err as Error).message));
  }
  const r = await supabase.rpc("request_history", { p_connection_id: id, p_from: period!.from, p_to: period!.to });
  if (r.error) back(friendly(r.error.message));
  revalidatePath("/app", "layout");
  kickJobs();
  redirect(`/app/connections/${id}?restarted=${r.data}&rfrom=${period!.from}&rto=${period!.to}#history`);
}

export async function requestHistoryAction(form: FormData): Promise<void> {
  const { supabase } = await requireUser();
  const id = String(form.get("connection_id") ?? "");
  const from = String(form.get("from") ?? "");
  const to = String(form.get("to") ?? "");
  const r = await supabase.rpc("request_history", { p_connection_id: id, p_from: from, p_to: to });
  if (r.error) {
    const m = r.error.message;
    const msg = /invalid window/.test(m)
      ? "Choose complete past days (up to yesterday), at most 400 days back."
      : /already in progress/.test(m)
        ? "A history load is already running for this connector."
        : friendly(m);
    redirect(`/app/connections/${id}?error=` + encodeURIComponent(msg) + "#history");
  }
  kickJobs();
  redirect(`/app/connections/${id}?history=${r.data}#history`);
}

export async function startLoadingAction(form: FormData): Promise<void> {
  const { supabase, user } = await requireUser();
  const id = String(form.get("connection_id") ?? "");
  const from = String(form.get("from") ?? "");
  const to = String(form.get("to") ?? "");
  const back = (msg: string) => redirect(`/app/connections/${id}?setup=1&error=` + encodeURIComponent(msg) + "#setup");
  try {
    await updateSchedule(getPool(), user.id, id, {
      frequency: String(form.get("frequency") ?? "daily"),
      localTime: String(form.get("local_time") ?? "06:00").slice(0, 5),
    });
  } catch (err) {
    back(/invalid time/.test((err as Error).message) ? "Please choose a valid time." : friendly((err as Error).message));
  }
  const r = await supabase.rpc("request_history", { p_connection_id: id, p_from: from, p_to: to });
  if (r.error) back(/invalid window/.test(r.error.message) ? "Choose complete past days (up to yesterday), at most 400 days back." : friendly(r.error.message));
  await getPool().query(
    `update public.company_connections set activated_at = coalesce(activated_at, now()), updated_at = now() where id = $1`,
    [id],
  );
  kickJobs();
  redirect(`/app/connections/${id}?started=${r.data}#history`);
}
