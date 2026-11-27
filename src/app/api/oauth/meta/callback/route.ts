import { type NextRequest, NextResponse } from "next/server";
import { getUser } from "@/server/supabase/server";
import { getPool, withTransaction } from "@/server/db";
import { createLiveConnection } from "@/server/oauth/connect";
import { loadConfig, metaOAuthConfigured } from "@/server/config";
import { getCompanyAccess } from "@/server/auth/authz";
import { encryptSecret, redact, sha256Hex } from "@/server/crypto";
import { exchangeMetaCode, listMetaAdAccounts, META_SCOPE, type MetaAppConfig } from "@/server/connectors/meta";

// Facebook callback: single-use state bound to the same signed-in user, company
// access re-checked, code exchanged for a long-lived token (stored encrypted,
// never shown). One ad account → connected at once; several → the user ticks them.
export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const cfg = loadConfig();
  const back = (msg: string) => NextResponse.redirect(new URL(`/app/connections?oauth=${encodeURIComponent(msg)}`, cfg.appUrl));
  if (!metaOAuthConfigured(cfg)) return back("Facebook connections are not configured.");
  const { user } = await getUser();
  if (!user) return NextResponse.redirect(new URL("/login", cfg.appUrl));
  if (url.searchParams.get("error")) return back("Facebook sign-in was cancelled or denied.");
  const state = url.searchParams.get("state") ?? "";
  const code = url.searchParams.get("code") ?? "";
  if (!state || !code) return back("Invalid response from Facebook.");

  const db = getPool();
  const st = (
    await db.query<{ company_id: string; workspace_id: string }>(
      `update public.oauth_states set used_at = now()
        where state_hash = $1 and used_at is null and expires_at > now() and user_id = $2 and provider_id = 'meta_ads'
        returning company_id, workspace_id`,
      [sha256Hex(state), user.id],
    )
  ).rows[0];
  if (!st) return back("This connection attempt expired. Please try again.");
  if ((await getCompanyAccess(db, user.id, st.company_id)) !== "manage") return back("Not found, or you do not have access.");

  const app: MetaAppConfig = { appId: cfg.meta.appId!, appSecret: cfg.meta.appSecret!, apiVersion: cfg.meta.apiVersion, redirectUri: cfg.meta.redirectUri };
  let token: string;
  let accounts: { id: string; name: string; group: string | null }[];
  try {
    token = await exchangeMetaCode(fetch, app, code);
    accounts = await listMetaAdAccounts(fetch, app, token);
  } catch (err) {
    const e = err as { code?: string; message?: string };
    console.error(JSON.stringify({ level: "warn", msg: "meta.oauth_failed", code: e.code, error: redact(String(e.message ?? "")) }));
    return back(e.code === "permission_denied"
      ? "Facebook did not allow reading your ad accounts. Please connect again and allow access to your ad accounts."
      : "Facebook did not accept the sign-in. Please try again.");
  }
  if (accounts.length === 0) {
    return back("This Facebook account has no active ad accounts. Sign in with the Facebook account that manages your ads (Meta Business Suite → Ads Manager).");
  }
  if (accounts.length === 1) {
    const id = await withTransaction((c) =>
      createLiveConnection(c, {
        workspaceId: st.workspace_id,
        companyId: st.company_id,
        userId: user.id,
        provider: "meta_ads",
        account: accounts[0]!,
        refreshToken: token,
        scopes: [META_SCOPE],
        encryptionKey: cfg.tokenEncryptionKey!,
      }),
    );
    return NextResponse.redirect(new URL(`/app/connections/${id}?setup=1`, cfg.appUrl));
  }
  const grant = await db.query<{ id: string }>(
    `insert into public.oauth_pending_grants (user_id, workspace_id, company_id, provider_id, ciphertext, scopes, accounts)
     values ($1, $2, $3, 'meta_ads', 'pending', $4, $5) returning id`,
    [user.id, st.workspace_id, st.company_id, [META_SCOPE], JSON.stringify(accounts.slice(0, 500))],
  );
  const grantId = grant.rows[0]!.id;
  await db.query(`update public.oauth_pending_grants set ciphertext = $2 where id = $1`, [grantId, encryptSecret(token, cfg.tokenEncryptionKey!, `pending:${grantId}`)]);
  return NextResponse.redirect(new URL(`/app/connections/choose?grant=${grantId}`, cfg.appUrl));
}
