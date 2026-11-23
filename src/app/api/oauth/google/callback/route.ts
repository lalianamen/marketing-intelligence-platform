import { type NextRequest, NextResponse } from "next/server";
import { getUser } from "@/server/supabase/server";
import { getPool, withTransaction } from "@/server/db";
import { googleOAuthConfigured, loadConfig } from "@/server/config";
import { getCompanyAccess } from "@/server/auth/authz";
import { decryptSecret, encryptSecret, sha256Hex } from "@/server/crypto";
import { exchangeCode, GA4_SCOPE, GOOGLE_ADS_SCOPE } from "@/server/connectors/google";

// OAuth callback: validates single-use state bound to the same signed-in user,
// re-checks company authorization, exchanges the code (PKCE), stores ONLY the
// encrypted refresh token, and creates a live connection + daily schedule.
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

  let tokens: { refreshToken: string | null; scopes: string[] };
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
  if (!tokens.scopes.includes(required)) return back("The required permission was not granted.");
  if (!tokens.refreshToken) return back("Google did not return a long-lived authorization. Remove the app's access in your Google account and try again.");

  await withTransaction(async (c) => {
    const conn = await c.query<{ id: string }>(
      `insert into public.company_connections (workspace_id, company_id, provider_id, mode, status, external_account_id, external_account_name, scopes, created_by)
       values ($1, $2, $3, 'live', 'connected', $4, $5, $6, $7)
       on conflict (company_id, provider_id, mode, coalesce(external_account_id, ''))
       do update set status = 'connected', scopes = excluded.scopes, last_error = null, consecutive_failures = 0, updated_at = now()
       returning id`,
      [st.workspace_id, st.company_id, st.provider_id, st.external_account_id, st.provider_id === "ga4" ? `GA4 property ${st.external_account_id}` : `Google Ads ${st.external_account_id}`, tokens.scopes, user.id],
    );
    const id = conn.rows[0]!.id;
    await c.query(
      `insert into public.connection_secrets (connection_id, workspace_id, company_id, ciphertext)
       values ($1, $2, $3, $4)
       on conflict (connection_id) do update set ciphertext = excluded.ciphertext, updated_at = now()`,
      [id, st.workspace_id, st.company_id, encryptSecret(tokens.refreshToken!, cfg.tokenEncryptionKey!, id)],
    );
    await c.query(
      `insert into public.sync_schedules (workspace_id, company_id, connection_id, frequency, local_time, timezone, buffer_minutes, next_run_at)
       select $1, $2, $3, 'daily', coalesce(s.sync_local_time, '06:00'), co.timezone, $4, now()
         from public.companies co left join public.company_settings s on s.company_id = co.id where co.id = $2
       on conflict (connection_id) do update set enabled = true, updated_at = now()`,
      [st.workspace_id, st.company_id, id, st.provider_id === "ga4" ? 60 : 30],
    );
    await c.query(
      `insert into public.audit_logs (workspace_id, company_id, actor_user_id, action, target_type, target_id, metadata)
       values ($1, $2, $3, 'connection.live_connected', 'connection', $4, $5)`,
      [st.workspace_id, st.company_id, user.id, id, JSON.stringify({ provider: st.provider_id })],
    );
  });
  return NextResponse.redirect(new URL("/app/connections?queued=1", loadConfig().appUrl));
}
