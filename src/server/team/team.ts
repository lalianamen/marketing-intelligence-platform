import "server-only";
import type { Queryable } from "../db";
import { requireWorkspaceRole } from "../auth/authz";

// Users with access to chosen companies of a workspace (Account settings → Users).
// Only the workspace owner/admin may read or change this. Roles:
//   Viewer = company_viewer (sees numbers, changes nothing)
//   Editor = company_admin  (connects sources, uploads, changes company settings)

export type MemberRole = "company_viewer" | "company_admin";
export const ROLE_LABEL: Record<MemberRole, string> = { company_viewer: "Viewer", company_admin: "Editor" };
export const isMemberRole = (r: string): r is MemberRole => r === "company_viewer" || r === "company_admin";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export function normalizeEmail(raw: string): string | null {
  const e = raw.trim().toLowerCase();
  return e.length <= 254 && EMAIL_RE.test(e) ? e : null;
}

export interface TeamMember {
  userId: string;
  email: string;
  companies: { id: string; name: string; role: MemberRole }[];
}
export interface TeamInvitation {
  id: string;
  email: string;
  role: MemberRole;
  companies: { id: string; name: string }[];
  expiresAt: string;
}

export async function loadTeam(db: Queryable, actorId: string, workspaceId: string): Promise<{ members: TeamMember[]; invitations: TeamInvitation[] }> {
  await requireWorkspaceRole(db, actorId, workspaceId, ["owner", "admin"]);
  const rows = (
    await db.query<{ user_id: string; email: string; company_id: string; company_name: string; role: MemberRole }>(
      `select cm.user_id, u.email, cm.company_id, c.name as company_name, cm.role
         from public.company_members cm
         join public.companies c on c.id = cm.company_id and c.status = 'active'
         join auth.users u on u.id = cm.user_id
        where cm.workspace_id = $1
        order by u.email, c.name`,
      [workspaceId],
    )
  ).rows;
  const byUser = new Map<string, TeamMember>();
  for (const r of rows) {
    const m = byUser.get(r.user_id) ?? { userId: r.user_id, email: r.email, companies: [] };
    m.companies.push({ id: r.company_id, name: r.company_name, role: r.role });
    byUser.set(r.user_id, m);
  }
  const inv = (
    await db.query<{ id: string; email: string; role: MemberRole; company_ids: string[]; expires_at: Date }>(
      `select id, email, role, company_ids, expires_at from public.company_invitations
        where workspace_id = $1 and accepted_at is null and revoked_at is null and expires_at > now()
        order by created_at desc`,
      [workspaceId],
    )
  ).rows;
  const names = new Map(
    (await db.query<{ id: string; name: string }>(`select id, name from public.companies where workspace_id = $1 and status = 'active'`, [workspaceId])).rows.map((c) => [c.id, c.name]),
  );
  return {
    members: [...byUser.values()],
    invitations: inv.map((i) => ({
      id: i.id,
      email: i.email,
      role: i.role,
      companies: i.company_ids.filter((id) => names.has(id)).map((id) => ({ id, name: names.get(id)! })),
      expiresAt: new Date(i.expires_at).toISOString().slice(0, 10),
    })),
  };
}

/** Creates (or replaces) the open invitation of an email. Returns an error message or null. */
export async function inviteUser(
  db: Queryable,
  actorId: string,
  args: { workspaceId: string; email: string; role: MemberRole; companyIds: string[] },
): Promise<string | null> {
  await requireWorkspaceRole(db, actorId, args.workspaceId, ["owner", "admin"]);
  const ids = [...new Set(args.companyIds)].slice(0, 500);
  if (ids.length === 0) return "Choose at least one company.";
  const ok = (
    await db.query<{ id: string }>(`select id from public.companies where workspace_id = $1 and status = 'active' and id = any($2::uuid[])`, [args.workspaceId, ids])
  ).rows.map((r) => r.id);
  if (ok.length !== ids.length) return "One of the chosen companies was not found.";
  const self = (await db.query<{ email: string }>(`select lower(email) as email from auth.users where id = $1`, [actorId])).rows[0]?.email;
  if (self === args.email) return "That is your own email: you already have full access.";
  const owner = (
    await db.query(`select 1 from public.workspace_members wm join auth.users u on u.id = wm.user_id where wm.workspace_id = $1 and lower(u.email) = $2`, [args.workspaceId, args.email])
  ).rowCount;
  if (owner) return "This person is already a member of the whole workspace.";
  await db.query(
    `update public.company_invitations set revoked_at = now()
      where workspace_id = $1 and email = $2 and accepted_at is null and revoked_at is null`,
    [args.workspaceId, args.email],
  );
  const id = (
    await db.query<{ id: string }>(
      `insert into public.company_invitations (workspace_id, email, role, company_ids, invited_by) values ($1, $2, $3, $4, $5) returning id`,
      [args.workspaceId, args.email, args.role, ok, actorId],
    )
  ).rows[0]!.id;
  // Someone who already has an account gets the access right away; others on sign-up.
  const existing = (await db.query<{ id: string }>(`select id from auth.users where lower(email) = $1 and email_confirmed_at is not null`, [args.email])).rows[0];
  if (existing) {
    await db.query(
      `insert into public.company_members (company_id, workspace_id, user_id, role)
       select c.id, c.workspace_id, $3, $4 from public.companies c where c.workspace_id = $1 and c.id = any($2::uuid[])
       on conflict (company_id, user_id) do update set role = excluded.role`,
      [args.workspaceId, ok, existing.id, args.role],
    );
    await db.query(`update public.company_invitations set accepted_at = now(), accepted_by = $2 where id = $1`, [id, existing.id]);
  }
  await audit(db, args.workspaceId, actorId, "invitation.created", id, { role: args.role, companies: ok.length, immediate: Boolean(existing) });
  return null;
}

export async function revokeInvitation(db: Queryable, actorId: string, workspaceId: string, invitationId: string): Promise<void> {
  await requireWorkspaceRole(db, actorId, workspaceId, ["owner", "admin"]);
  await db.query(`update public.company_invitations set revoked_at = now() where id = $1 and workspace_id = $2 and accepted_at is null`, [invitationId, workspaceId]);
  await audit(db, workspaceId, actorId, "invitation.revoked", invitationId);
}

/** Sets a person's role for one company, or removes their access to it (role null). */
export async function setMemberAccess(
  db: Queryable,
  actorId: string,
  args: { workspaceId: string; userId: string; companyId: string; role: MemberRole | null },
): Promise<void> {
  await requireWorkspaceRole(db, actorId, args.workspaceId, ["owner", "admin"]);
  if (args.role === null) {
    await db.query(`delete from public.company_members where workspace_id = $1 and user_id = $2 and company_id = $3`, [args.workspaceId, args.userId, args.companyId]);
  } else {
    await db.query(`update public.company_members set role = $4 where workspace_id = $1 and user_id = $2 and company_id = $3`, [
      args.workspaceId,
      args.userId,
      args.companyId,
      args.role,
    ]);
  }
  await audit(db, args.workspaceId, actorId, args.role ? "member.role_changed" : "member.removed", args.userId, { company_id: args.companyId, role: args.role });
}

/** Removes a person from every company of the workspace. */
export async function removeMember(db: Queryable, actorId: string, workspaceId: string, userId: string): Promise<void> {
  await requireWorkspaceRole(db, actorId, workspaceId, ["owner", "admin"]);
  await db.query(`delete from public.company_members where workspace_id = $1 and user_id = $2`, [workspaceId, userId]);
  await audit(db, workspaceId, actorId, "member.removed", userId, { all: true });
}

async function audit(db: Queryable, workspaceId: string, actorId: string, action: string, targetId: string, metadata: Record<string, unknown> = {}) {
  await db.query(
    `insert into public.audit_logs (workspace_id, actor_user_id, action, target_type, target_id, metadata) values ($1, $2, $3, 'team', $4, $5)`,
    [workspaceId, actorId, action, targetId, JSON.stringify(metadata)],
  );
}
