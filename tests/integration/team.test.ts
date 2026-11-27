import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { randomUUID } from "node:crypto";
import { getCompanyAccess } from "@/server/auth/authz";
import { inviteUser, loadTeam, removeMember, revokeInvitation, setMemberAccess } from "@/server/team/team";
import { adminClient, anonClient, createCompany, createVerifiedUser, pool, type TestUser } from "./helpers";

let owner: TestUser;
let a: string;
let b: string;

beforeAll(async () => {
  owner = await createVerifiedUser("owner");
  a = await createCompany(owner, "Company A");
  b = await createCompany(owner, "Company B");
});
afterAll(async () => {
  await pool.end();
});

/** Signs up a confirmed user with a known email (the invited address). */
async function signUp(email: string): Promise<TestUser> {
  const password = `Pw-${randomUUID()}1a`;
  const { data, error } = await adminClient().auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw error;
  const client = anonClient();
  await client.auth.signInWithPassword({ email, password });
  const ws = await client.rpc("bootstrap_workspace", {});
  return { id: data.user!.id, email, client, workspaceId: ws.data as string };
}

describe("Users and access (invitations to chosen companies)", () => {
  it("a viewer invited to one company sees only that company, read-only; nothing else", async () => {
    const email = `viewer-${randomUUID().slice(0, 8)}@example.test`;
    expect(await inviteUser(pool, owner.id, { workspaceId: owner.workspaceId, email, role: "company_viewer", companyIds: [a] })).toBeNull();
    const v = await signUp(email);
    expect(await v.client.rpc("accept_my_invitations", {})).toMatchObject({ data: 1 });
    const { data: visible } = await v.client.from("companies").select("id").eq("workspace_id", owner.workspaceId);
    expect((visible ?? []).map((c) => c.id)).toEqual([a]);
    expect(await getCompanyAccess(pool, v.id, a)).toBe("read");
    expect(await getCompanyAccess(pool, v.id, b)).toBeNull();
    // Read-only: renaming the company through RLS changes nothing; connecting or clearing is refused.
    await v.client.from("companies").update({ name: "hacked" }).eq("id", a);
    expect((await pool.query(`select name from public.companies where id = $1`, [a])).rows[0].name).toBe("Company A");
    expect((await v.client.rpc("ensure_csv_connection", { p_company_id: a })).error).not.toBeNull();
    expect((await v.client.rpc("clear_company_data", { p_company_id: a, p_confirm_name: "Company A" })).error).not.toBeNull();
    // The invitation table itself is not readable by anyone through the API.
    expect((await v.client.from("company_invitations").select("*")).data ?? []).toEqual([]);
  });

  it("an editor can change the companies chosen for them, but not delete them or add people", async () => {
    const email = `editor-${randomUUID().slice(0, 8)}@example.test`;
    await inviteUser(pool, owner.id, { workspaceId: owner.workspaceId, email, role: "company_admin", companyIds: [a, b] });
    const e = await signUp(email);
    await e.client.rpc("accept_my_invitations", {});
    expect(await getCompanyAccess(pool, e.id, a)).toBe("manage");
    expect(await getCompanyAccess(pool, e.id, b)).toBe("manage");
    expect((await e.client.rpc("delete_company", { p_company_id: b, p_confirm_name: "Company B" })).error).not.toBeNull();
    await expect(inviteUser(pool, e.id, { workspaceId: owner.workspaceId, email: "x@example.test", role: "company_viewer", companyIds: [a] })).rejects.toThrow();

    // Owner narrows access: viewer in A, nothing in B; then removes the person entirely.
    await setMemberAccess(pool, owner.id, { workspaceId: owner.workspaceId, userId: e.id, companyId: a, role: "company_viewer" });
    await setMemberAccess(pool, owner.id, { workspaceId: owner.workspaceId, userId: e.id, companyId: b, role: null });
    expect([await getCompanyAccess(pool, e.id, a), await getCompanyAccess(pool, e.id, b)]).toEqual(["read", null]);
    await removeMember(pool, owner.id, owner.workspaceId, e.id);
    expect(await getCompanyAccess(pool, e.id, a)).toBeNull();
  });

  it("someone who already has an account gets access at once; a cancelled invitation gives nothing; other workspaces are refused", async () => {
    const existing = await createVerifiedUser("existing");
    await inviteUser(pool, owner.id, { workspaceId: owner.workspaceId, email: existing.email, role: "company_viewer", companyIds: [b] });
    expect(await getCompanyAccess(pool, existing.id, b)).toBe("read");

    const email = `late-${randomUUID().slice(0, 8)}@example.test`;
    await inviteUser(pool, owner.id, { workspaceId: owner.workspaceId, email, role: "company_admin", companyIds: [a] });
    const team = await loadTeam(pool, owner.id, owner.workspaceId);
    const inv = team.invitations.find((i) => i.email === email)!;
    expect(inv.companies.map((c) => c.name)).toEqual(["Company A"]);
    await revokeInvitation(pool, owner.id, owner.workspaceId, inv.id);
    const late = await signUp(email);
    expect(await late.client.rpc("accept_my_invitations", {})).toMatchObject({ data: 0 });
    expect(await getCompanyAccess(pool, late.id, a)).toBeNull();

    // A company of another workspace cannot be shared by this owner.
    const other = await createVerifiedUser("other");
    const foreign = await createCompany(other, "Foreign");
    expect(await inviteUser(pool, owner.id, { workspaceId: owner.workspaceId, email: "y@example.test", role: "company_viewer", companyIds: [foreign] })).toMatch(/not found/);
    expect(await inviteUser(pool, owner.id, { workspaceId: owner.workspaceId, email: owner.email, role: "company_viewer", companyIds: [a] })).toMatch(/your own email/);
  });
});
