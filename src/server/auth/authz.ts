import type { Queryable } from "../db";

// Server-side authorization, independent of RLS (defence in depth). Every
// server action / route handler that uses the privileged pool or the warehouse
// MUST call one of these first. IDs are never trusted from the client: a forged
// or foreign company ID simply resolves to "no access".

export type CompanyAccess = "manage" | "read" | null;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class AccessDeniedError extends Error {
  constructor() {
    super("not found");
    this.name = "AccessDeniedError";
  }
}

export async function getCompanyAccess(db: Queryable, userId: string, companyId: string): Promise<CompanyAccess> {
  if (!UUID_RE.test(userId) || !UUID_RE.test(companyId)) return null;
  const r = await db.query<{ ws_role: string | null; c_role: string | null; status: string }>(
    `select c.status,
            (select wm.role from public.workspace_members wm where wm.workspace_id = c.workspace_id and wm.user_id = $1) as ws_role,
            (select cm.role from public.company_members cm where cm.company_id = c.id and cm.user_id = $1) as c_role
       from public.companies c where c.id = $2`,
    [userId, companyId],
  );
  const row = r.rows[0];
  if (!row) return null;
  if (row.ws_role && ["owner", "admin", "member"].includes(row.ws_role)) return "manage";
  if (row.c_role === "company_admin") return "manage";
  if (row.c_role === "company_viewer") return "read";
  return null;
}

export async function requireCompanyAccess(
  db: Queryable,
  userId: string,
  companyId: string,
  needed: "read" | "manage",
): Promise<{ access: "read" | "manage"; workspaceId: string }> {
  const access = await getCompanyAccess(db, userId, companyId);
  if (!access || (needed === "manage" && access !== "manage")) throw new AccessDeniedError();
  const ws = await db.query<{ workspace_id: string }>(`select workspace_id from public.companies where id = $1`, [companyId]);
  return { access, workspaceId: ws.rows[0]!.workspace_id };
}

export async function requireWorkspaceRole(
  db: Queryable,
  userId: string,
  workspaceId: string,
  roles: ("owner" | "admin" | "member")[],
): Promise<void> {
  if (!UUID_RE.test(workspaceId)) throw new AccessDeniedError();
  const r = await db.query<{ role: string }>(`select role from public.workspace_members where workspace_id = $1 and user_id = $2`, [
    workspaceId,
    userId,
  ]);
  const role = r.rows[0]?.role;
  if (!role || !roles.includes(role as never)) throw new AccessDeniedError();
}
