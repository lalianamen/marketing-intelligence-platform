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
  /** What the user may do in the selected company: manage (owner/editor) or read (viewer). */
  access: "manage" | "read" | null;
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
  // People invited to companies of another workspace get that access once their email is verified.
  await supabase.rpc("accept_my_invitations", {});

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
  let access: AppContext["access"] = null;
  if (company) {
    const wsRole = workspaces.find((w) => w.id === company.workspace_id)?.role;
    if (wsRole && ["owner", "admin", "member"].includes(wsRole)) access = "manage";
    else {
      const { data: cm } = await supabase.from("company_members").select("role").eq("company_id", company.id).eq("user_id", user.id).maybeSingle();
      access = cm?.role === "company_admin" ? "manage" : cm?.role === "company_viewer" ? "read" : null;
    }
  }
  return { userId: user.id, email: user.email ?? "", workspaces, workspace, companies: list, company, access };
}

/** For pages that only make sense inside a company: without one, go to the Companies list. */
export async function getCompanyContext(): Promise<AppContext & { company: CompanySummary }> {
  const ctx = await getAppContext();
  if (!ctx.company) redirect("/app/companies");
  return ctx as AppContext & { company: CompanySummary };
}

/** For pages that change a company (connect sources, upload): viewers are sent back with a note. */
export async function getManageContext(): Promise<AppContext & { company: CompanySummary }> {
  const ctx = await getCompanyContext();
  if (ctx.access !== "manage") redirect("/app/connections?oauth=" + encodeURIComponent("You have view-only access to this company."));
  return ctx;
}
