import "server-only";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getUser } from "./supabase/server";

export interface CompanySummary {
  id: string;
  name: string;
  timezone: string;
  workspace_id: string;
  website: string | null;
  industry: string | null;
  country: string | null;
  business_type: string;
}

export interface AppContext {
  userId: string;
  email: string;
  workspaces: { id: string; name: string; role: string }[];
  workspace: { id: string; name: string; role: string };
  companies: CompanySummary[];
  company: CompanySummary | null;
}

export const COMPANY_COOKIE = "mip_company";

/**
 * Resolves the signed-in user's workspace and selected company. All reads go
 * through the RLS-scoped client: a forged company id in the cookie or URL is
 * simply not found among the user's companies.
 */
export async function getAppContext(companyParam?: string | null): Promise<AppContext> {
  const { supabase, user } = await getUser();
  if (!user) redirect("/login");
  if (!user.email_confirmed_at) redirect("/check-email");

  // Idempotent onboarding: creates the workspace on first verified visit.
  const boot = await supabase.rpc("bootstrap_workspace", {});
  if (boot.error) throw new Error("Could not prepare your workspace. Please try again.");

  const { data: memberships } = await supabase.from("workspace_members").select("role, workspaces(id, name)");
  const workspaces = (memberships ?? [])
    .map((m) => {
      const w = m.workspaces as unknown as { id: string; name: string } | null;
      return w ? { id: w.id, name: w.name, role: m.role as string } : null;
    })
    .filter((x): x is { id: string; name: string; role: string } => x !== null);
  const workspace = workspaces.find((w) => w.id === boot.data) ?? workspaces[0];
  if (!workspace) throw new Error("No workspace available");

  const { data: companies } = await supabase
    .from("companies")
    .select("id, name, timezone, workspace_id, website, industry, country, business_type")
    .eq("status", "active")
    .order("created_at");
  const list = (companies ?? []) as CompanySummary[];
  const store = await cookies();
  const wanted = companyParam ?? store.get(COMPANY_COOKIE)?.value ?? null;
  // No silent fallback: the user picks a company on the Companies page and works inside it.
  const company = list.find((c) => c.id === wanted) ?? null;
  return { userId: user.id, email: user.email ?? "", workspaces, workspace, companies: list, company };
}

/** For pages that only make sense inside a company: without one, go to the Companies list. */
export async function getCompanyContext(): Promise<AppContext & { company: CompanySummary }> {
  const ctx = await getAppContext();
  if (!ctx.company) redirect("/app/companies");
  return ctx as AppContext & { company: CompanySummary };
}
