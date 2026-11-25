import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { decryptSecret } from "@/server/crypto";
import { withTransaction } from "@/server/db";
import { createLiveConnection } from "@/server/oauth/connect";
import { cfg, createCompany, createVerifiedUser, pool, type TestUser } from "./helpers";

let U: TestUser;
let other: TestUser;
let company: string;

beforeAll(async () => {
  U = await createVerifiedUser("oauthc");
  other = await createVerifiedUser("oauthx");
  company = await createCompany(U, "OAuth Co");
});
afterAll(async () => {
  await pool.end();
});

describe("connecting accounts found after Google sign-in", () => {
  it("creates one live connection per chosen account, each with its own encrypted token and a schedule", async () => {
    const ids = await withTransaction(async (c) => [
      await createLiveConnection(c, { workspaceId: U.workspaceId, companyId: company, userId: U.id, provider: "ga4", account: { id: "111", name: "licena.us", group: "LICENA LLC" }, refreshToken: "1//rt", scopes: ["s"], encryptionKey: cfg.tokenEncryptionKey! }),
      await createLiveConnection(c, { workspaceId: U.workspaceId, companyId: company, userId: U.id, provider: "ga4", account: { id: "222", name: "Blog", group: null }, refreshToken: "1//rt", scopes: ["s"], encryptionKey: cfg.tokenEncryptionKey! }),
    ], pool);
    expect(new Set(ids).size).toBe(2);
    const conns = (await pool.query(`select id, external_account_id, external_account_name, mode, status from public.company_connections where company_id = $1 order by external_account_id`, [company])).rows;
    expect(conns.map((c) => [c.external_account_id, c.external_account_name, c.mode, c.status])).toEqual([
      ["111", "licena.us · LICENA LLC", "live", "connected"],
      ["222", "Blog", "live", "connected"],
    ]);
    for (const id of ids) {
      const sec = (await pool.query(`select ciphertext from public.connection_secrets where connection_id = $1`, [id])).rows[0];
      expect(decryptSecret(sec.ciphertext, cfg.tokenEncryptionKey!, id)).toBe("1//rt");
      expect((await pool.query(`select enabled from public.sync_schedules where connection_id = $1`, [id])).rows[0].enabled).toBe(true);
    }
    // Reconnecting the same account updates it instead of duplicating.
    await withTransaction((c) => createLiveConnection(c, { workspaceId: U.workspaceId, companyId: company, userId: U.id, provider: "ga4", account: { id: "111", name: "licena.us", group: null }, refreshToken: "1//new", scopes: ["s"], encryptionKey: cfg.tokenEncryptionKey! }), pool);
    expect((await pool.query(`select count(*)::int n from public.company_connections where company_id = $1`, [company])).rows[0].n).toBe(2);
  });

  it("pending grants are invisible to signed-in users (server only)", async () => {
    await pool.query(
      `insert into public.oauth_pending_grants (user_id, workspace_id, company_id, provider_id, ciphertext, accounts) values ($1, $2, $3, 'ga4', 'x', '[]')`,
      [U.id, U.workspaceId, company],
    );
    for (const u of [U, other]) {
      const r = await u.client.from("oauth_pending_grants").select("*");
      expect(r.data ?? []).toEqual([]);
    }
  });
});
