import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { anonClient, createVerifiedUser, pool } from "./helpers";

const MAILPIT = process.env.MAILPIT_URL ?? "http://127.0.0.1:54324";

async function waitForEmail(to: string, subjectPart: string): Promise<string> {
  for (let i = 0; i < 40; i++) {
    const r = await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}`);
    const j = (await r.json()) as { messages?: { ID: string; Subject: string }[] };
    const m = j.messages?.find((x) => x.Subject.includes(subjectPart));
    if (m) {
      const full = (await (await fetch(`${MAILPIT}/api/v1/message/${m.ID}`)).json()) as { HTML: string };
      return full.HTML;
    }
    await new Promise((res) => setTimeout(res, 250));
  }
  throw new Error(`no email for ${to}`);
}

function tokenHash(html: string): string {
  const m = /token_hash=([a-zA-Z0-9_-]+)/.exec(html);
  if (!m) throw new Error("no token_hash in email");
  return m[1]!;
}

afterAll(async () => {
  await pool.end();
});

describe("registration, email verification, login/logout, workspace bootstrap", () => {
  const email = `signup-${randomUUID().slice(0, 8)}@example.test`;
  const password = `Pw-${randomUUID()}1a`;

  it("sign-up requires email verification before a session/workspace exists", async () => {
    const c = anonClient();
    const { data, error } = await c.auth.signUp({ email, password, options: { emailRedirectTo: "http://127.0.0.1:3000/auth/confirm" } });
    expect(error).toBeNull();
    expect(data.session).toBeNull(); // confirmation required
    const login = await c.auth.signInWithPassword({ email, password });
    expect(login.error?.message).toMatch(/not confirmed/i);
    const ws = await pool.query(`select count(*)::int as n from public.workspaces w join auth.users u on u.id = w.created_by where u.email = $1`, [email]);
    expect(ws.rows[0].n).toBe(0);
  });

  it("weak passwords are rejected by Auth policy", async () => {
    const r = await anonClient().auth.signUp({ email: `weak-${randomUUID().slice(0, 6)}@example.test`, password: "short" });
    expect(r.error).not.toBeNull();
  });

  it("verifying the emailed token_hash creates a session; bootstrap_workspace is idempotent", async () => {
    const html = await waitForEmail(email, "Confirm");
    expect(html).toContain("/auth/confirm?token_hash=");
    const c = anonClient();
    const v = await c.auth.verifyOtp({ token_hash: tokenHash(html), type: "email" });
    expect(v.error).toBeNull();
    expect(v.data.session).not.toBeNull();

    const [a, b, d] = await Promise.all([
      c.rpc("bootstrap_workspace", { p_name: "Acme Agency" }),
      c.rpc("bootstrap_workspace", { p_name: "Acme Agency" }),
      c.rpc("bootstrap_workspace", {}),
    ]);
    expect(a.error).toBeNull();
    expect(a.data).toBe(b.data);
    expect(d.data).toBe(a.data);
    const members = await c.from("workspace_members").select("role");
    expect(members.data).toEqual([{ role: "owner" }]);
    const ws = await c.from("workspaces").select("name");
    expect(ws.data).toEqual([{ name: "Acme Agency" }]);
  });

  it("login and logout: after sign-out the API returns no tenant data", async () => {
    const c = anonClient();
    const s = await c.auth.signInWithPassword({ email, password });
    expect(s.error).toBeNull();
    expect((await c.from("workspaces").select("id")).data).toHaveLength(1);
    await c.auth.signOut();
    const after = await c.from("workspaces").select("id");
    expect(after.data ?? []).toHaveLength(0);
    const rpc = await c.rpc("bootstrap_workspace", {});
    expect(rpc.error).not.toBeNull();
  });

  it("password reset email uses the token_hash flow and allows setting a new password", async () => {
    const c = anonClient();
    const r = await c.auth.resetPasswordForEmail(email, { redirectTo: "http://127.0.0.1:3000/auth/confirm?next=/reset-password" });
    expect(r.error).toBeNull();
    const html = await waitForEmail(email, "Reset");
    const v = await c.auth.verifyOtp({ token_hash: tokenHash(html), type: "recovery" });
    expect(v.error).toBeNull();
    const newPw = `Pw-${randomUUID()}2b`;
    expect((await c.auth.updateUser({ password: newPw })).error).toBeNull();
    await c.auth.signOut();
    expect((await anonClient().auth.signInWithPassword({ email, password: newPw })).error).toBeNull();
    expect((await anonClient().auth.signInWithPassword({ email, password })).error).not.toBeNull();
  });

  it("a second unrelated user gets a separate workspace", async () => {
    const other = await createVerifiedUser("other");
    const own = await other.client.from("workspaces").select("id");
    expect(own.data!.map((x) => x.id)).toEqual([other.workspaceId]);
  });
});
