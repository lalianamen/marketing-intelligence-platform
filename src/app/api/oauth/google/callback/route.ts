import { type NextRequest, NextResponse } from "next/server";
import { getUser } from "@/server/supabase/server";
import { getPool, withTransaction } from "@/server/db";
import { kickJobs } from "@/server/jobs/kick";
import { createLiveConnection, defaultAccountName } from "@/server/oauth/connect";
import type { ConnectorError } from "@/server/connectors/types";
import { googleOAuthConfigured, loadConfig } from "@/server/config";
import { getCompanyAccess } from "@/server/auth/authz";
import { decryptSecret, encryptSecret, redact, sha256Hex } from "@/server/crypto";
import { type DiscoveredAccount, exchangeCode, GA4_SCOPE, GOOGLE_ADS_SCOPE, listAdsCustomers, listGa4Properties, refreshAccessToken } from "@/server/connectors/google";

// OAuth callback: validates single-use state bound to the same signed-in user,
// re-checks company authorization, exchanges the code (PKCE), stores ONLY the
// encrypted refresh token, lists the user's GA4 properties / Ads accounts and
// connects the only one, or lets the user choose when there are several.
export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const back = (msg: string) => NextResponse.redirect(new URL(`/app/connections?oauth=${encodeURIComponent(msg)}`, loadConfig().appUrl));
  const cfg = loadConfig();
  if (!googleOAuthConfigured(cfg)) return back("Google connections are not configured.");
  const { user } = await getUser();
  if (!user) return NextResponse.redirect(new URL("/login", loadConfig().appUrl));
  if (url.searchParams.get("error")) return back("Google sign-in was cancelled or denied.");
  const state = url.searchParams.get("state") ?? "";
  const code = url.searchParams.get("code") ?? "";
  if (!state || !code) return back("Invalid response from Google.");

  const db = getPool();
  const st = (
    await db.query(
      `update public.oauth_states set used_at = now()
        where state_hash = $1 and used_at is null and expires_at > now() and user_id = $2
        returning *`,
      [sha256Hex(state), user.id],
    )
  ).rows[0] as
    | { company_id: string; workspace_id: string; provider_id: "ga4" | "google_ads"; code_verifier_ciphertext: string; external_account_id: string }
    | undefined;
  if (!st) return back("This connection attempt expired. Please try again.");
  if ((await getCompanyAccess(db, user.id, st.company_id)) !== "manage") return back("Not found, or you do not have access.");

  let tokens: { refreshToken: string | null; accessToken: string | null; scopes: string[] };
  try {
    tokens = await exchangeCode(
      { clientId: cfg.google.clientId!, clientSecret: cfg.google.clientSecret!, redirectUri: cfg.google.redirectUri },
      code,
      decryptSecret(st.code_verifier_ciphertext, cfg.tokenEncryptionKey!, "oauth-verifier"),
    );
  } catch {
    return back("Google did not accept the authorization. Please try again.");
  }
  const required = st.provider_id === "ga4" ? GA4_SCOPE : GOOGLE_ADS_SCOPE;
  if (!tokens.scopes.includes(required)) return back("The required permission was not granted. Please tick the box to allow access.");
  if (!tokens.refreshToken) return back("Google did not return a long-lived authorization. Remove the app's access in your Google account and try again.");
  const refreshToken = tokens.refreshToken;
  const label = st.provider_id === "ga4" ? "Google Analytics" : "Google Ads";

  // Which accounts can this Google user read? (Skipped when an ID was typed in.)
  let accounts: DiscoveredAccount[];
  if (st.external_account_id) {
    accounts = [{ id: st.external_account_id, name: defaultAccountName(st.provider_id, st.external_account_id), group: null }];
  } else {
    try {
      const accessToken = tokens.accessToken ?? (await refreshAccessToken({ clientId: cfg.google.clientId!, clientSecret: cfg.google.clientSecret! }, refreshToken));
      accounts =
        st.provider_id === "ga4"
          ? await listGa4Properties(accessToken)
          : await listAdsCustomers(accessToken, { apiVersion: cfg.google.adsApiVersion, developerToken: cfg.google.adsDeveloperToken });
    } catch (err) {
      const e = err as ConnectorError;
      console.error(JSON.stringify({ level: "warn", msg: "oauth.discovery_failed", provider: st.provider_id, code: e.code, error: redact(e.message ?? "") }));
      if (e.code === "not_configured") return back(`${label} account listing is not enabled for this app yet (administrator: enable the API in Google Cloud).`);
      if (st.provider_id === "google_ads" && e.code === "permission_denied")
        return back("Google Ads did not allow this app to read your accounts yet: the app's Google Ads API access is still limited to test accounts.");
      return back(`Could not read your ${label} accounts from Google. Please try again.`);
    }
  }
  if (accounts.length === 0) {
    return back(st.provider_id === "ga4"
      ? "This Google account has no Google Analytics 4 properties. Sign in with the Google account that has access to your GA4."
      : "This Google account has no Google Ads accounts. Sign in with the Google account that has access to your Google Ads.");
  }

  if (accounts.length === 1) {
    const connectionId = await withTransaction((c) =>
      createLiveConnection(c, {
        workspaceId: st.workspace_id,
        companyId: st.company_id,
        userId: user.id,
        provider: st.provider_id,
        account: accounts[0]!,
        refreshToken,
        scopes: tokens.scopes,
        encryptionKey: cfg.tokenEncryptionKey!,
      }),
    );
    await startFirstSync(connectionId);
    return NextResponse.redirect(new URL(`/app/connections?connected=${encodeURIComponent(accounts[0]!.name)}`, cfg.appUrl));
  }

  // Several accounts: keep the encrypted grant for 30 minutes and let the user choose.
  const grant = await db.query<{ id: string }>(
    `insert into public.oauth_pending_grants (user_id, workspace_id, company_id, provider_id, ciphertext, scopes, accounts)
     values ($1, $2, $3, $4, 'pending', $5, $6) returning id`,
    [user.id, st.workspace_id, st.company_id, st.provider_id, tokens.scopes, JSON.stringify(accounts.slice(0, 500))],
  );
  const grantId = grant.rows[0]!.id;
  await db.query(`update public.oauth_pending_grants set ciphertext = $2 where id = $1`, [
    grantId,
    encryptSecret(refreshToken, cfg.tokenEncryptionKey!, `pending:${grantId}`),
  ]);
  return NextResponse.redirect(new URL(`/app/connections/choose?grant=${grantId}`, cfg.appUrl));
}

/** Queue the first import right away and process it after the response. */
async function startFirstSync(connectionId: string): Promise<void> {
  const { supabase } = await getUser();
  const r = await supabase.rpc("request_sync", { p_connection_id: connectionId });
  if (!r.error) kickJobs();
}
