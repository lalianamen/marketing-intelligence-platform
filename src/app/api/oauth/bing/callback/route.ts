import { type NextRequest, NextResponse } from "next/server";
import { getUser } from "@/server/supabase/server";
import { getPool, withTransaction } from "@/server/db";
import { createLiveConnection } from "@/server/oauth/connect";
import { bingOAuthConfigured, loadConfig } from "@/server/config";
import { getCompanyAccess } from "@/server/auth/authz";
import { encryptSecret, redact, sha256Hex } from "@/server/crypto";
import { BING_OAUTH_PREFIX, BING_SCOPE, exchangeBingCode, listBingSites } from "@/server/connectors/bing";

// Bing OAuth callback: single-use state bound to the same signed-in user, company
// access re-checked, code exchanged, ONLY the encrypted refresh token stored.
// One verified site → connected at once; several → the user ticks them.
export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const cfg = loadConfig();
  const back = (msg: string) => NextResponse.redirect(new URL(`/app/connections?oauth=${encodeURIComponent(msg)}`, cfg.appUrl));
  if (!bingOAuthConfigured(cfg)) return back("Bing connections are not configured.");
  const { user } = await getUser();
  if (!user) return NextResponse.redirect(new URL("/login", cfg.appUrl));
  if (url.searchParams.get("error")) return back("Bing sign-in was cancelled or denied.");
  const state = url.searchParams.get("state") ?? "";
  const code = url.searchParams.get("code") ?? "";
  if (!state || !code) return back("Invalid response from Bing.");

  const db = getPool();
  const st = (
    await db.query<{ company_id: string; workspace_id: string }>(
      `update public.oauth_states set used_at = now()
        where state_hash = $1 and used_at is null and expires_at > now() and user_id = $2 and provider_id = 'bing_webmaster'
        returning company_id, workspace_id`,
      [sha256Hex(state), user.id],
    )
  ).rows[0];
  if (!st) return back("This connection attempt expired. Please try again.");
  if ((await getCompanyAccess(db, user.id, st.company_id)) !== "manage") return back("Not found, or you do not have access.");

  let tokens: { refreshToken: string | null; accessToken: string | null };
  try {
    tokens = await exchangeBingCode(fetch, { clientId: cfg.bing.clientId!, clientSecret: cfg.bing.clientSecret!, redirectUri: cfg.bing.redirectUri }, code);
  } catch (err) {
    console.error(JSON.stringify({ level: "warn", msg: "bing.oauth_exchange_failed", error: redact(String((err as Error).message)) }));
    return back("Bing did not accept the sign-in. Please try again.");
  }
  if (!tokens.refreshToken || !tokens.accessToken) return back("Bing did not return a lasting sign-in. Please try again.");
  const secret = BING_OAUTH_PREFIX + tokens.refreshToken;

  let sites: string[];
  try {
    sites = await listBingSites(fetch, { accessToken: tokens.accessToken });
  } catch (err) {
    console.error(JSON.stringify({ level: "warn", msg: "bing.oauth_sites_failed", error: redact(String((err as Error).message)) }));
    return back("Could not read your sites from Bing. Please try again.");
  }
  if (sites.length === 0) {
    return back("This Bing account has no verified sites. In Bing Webmaster Tools, add your site (the quickest way: Import from Google Search Console), then connect again.");
  }
  const accounts = sites.map((s) => ({ id: s, name: s, group: null }));
  if (accounts.length === 1) {
    const id = await withTransaction((c) =>
      createLiveConnection(c, {
        workspaceId: st.workspace_id,
        companyId: st.company_id,
        userId: user.id,
        provider: "bing_webmaster",
        account: accounts[0]!,
        refreshToken: secret,
        scopes: [BING_SCOPE],
        encryptionKey: cfg.tokenEncryptionKey!,
      }),
    );
    return NextResponse.redirect(new URL(`/app/connections/${id}?setup=1`, cfg.appUrl));
  }
  const grant = await db.query<{ id: string }>(
    `insert into public.oauth_pending_grants (user_id, workspace_id, company_id, provider_id, ciphertext, scopes, accounts)
     values ($1, $2, $3, 'bing_webmaster', 'pending', $4, $5) returning id`,
    [user.id, st.workspace_id, st.company_id, [BING_SCOPE], JSON.stringify(accounts.slice(0, 500))],
  );
  const grantId = grant.rows[0]!.id;
  await db.query(`update public.oauth_pending_grants set ciphertext = $2 where id = $1`, [grantId, encryptSecret(secret, cfg.tokenEncryptionKey!, `pending:${grantId}`)]);
  return NextResponse.redirect(new URL(`/app/connections/choose?grant=${grantId}`, cfg.appUrl));
}
