import { createHash } from "node:crypto";
import { type NextRequest, NextResponse } from "next/server";
import { getUser } from "@/server/supabase/server";
import { getPool } from "@/server/db";
import { googleOAuthConfigured, loadConfig } from "@/server/config";
import { requireCompanyAccess } from "@/server/auth/authz";
import { encryptSecret, randomToken, sha256Hex } from "@/server/crypto";
import { GA4_SCOPE, GOOGLE_ADS_SCOPE, GOOGLE_AUTH_URL } from "@/server/connectors/google";
import { GA4_EDIT_SCOPE, GA4_MANAGE_USERS_SCOPE } from "@/server/connectors/ga4Admin";
import { GSC_SCOPE } from "@/server/connectors/searchConsole";

// Starts Google's official consent screen (authorization code + PKCE + state).
// The user never types a Google password into this app.
export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const back = (msg: string) => NextResponse.redirect(new URL(`/app/connections?oauth=${encodeURIComponent(msg)}`, loadConfig().appUrl));
  const cfg = loadConfig();
  if (!googleOAuthConfigured(cfg)) return back("Google connections are not configured by the administrator yet.");
  const { user } = await getUser();
  if (!user) return NextResponse.redirect(new URL("/login", loadConfig().appUrl));

  const provider = url.searchParams.get("provider");
  const companyId = url.searchParams.get("company") ?? "";
  // Search Console sites are always discovered after sign-in (no typed ID).
  const account = provider === "google_search_console" ? "" : (url.searchParams.get("account") ?? "").replace(/-/g, "").trim();
  if (provider !== "ga4" && provider !== "google_ads" && provider !== "google_search_console") return back("Unknown provider.");
  // The ID is optional: without it, the callback lists the user's accounts.
  if (account && provider !== "google_search_console" && (provider === "ga4" ? !/^\d{1,20}$/.test(account) : !/^\d{10}$/.test(account))) return back("Please enter a valid account ID.");

  const db = getPool();
  let workspaceId: string;
  try {
    ({ workspaceId } = await requireCompanyAccess(db, user.id, companyId, "manage"));
  } catch {
    return back("Not found, or you do not have access.");
  }
  // Turning on GA4's BigQuery export for an existing connection asks for more GA4 permissions (ADR 0006).
  const purpose = url.searchParams.get("purpose") === "ga4_export" ? "ga4_export" : "connect";
  let connectionId: string | null = null;
  if (purpose === "ga4_export") {
    const conn = (await db.query<{ id: string; external_account_id: string }>(
      `select id, external_account_id from public.company_connections
        where id = $1 and company_id = $2 and provider_id = 'ga4' and mode = 'live' and status <> 'disconnected'`,
      [url.searchParams.get("connection") ?? "", companyId],
    )).rows[0];
    if (!conn || provider !== "ga4") return back("Not found, or you do not have access.");
    connectionId = conn.id;
  }
  const rl = await db.query<{ ok: boolean }>("select private.rate_limit_hit($1, 10, 3600) as ok", [`oauth:${user.id}`]);
  if (!rl.rows[0]?.ok) return back("Too many attempts. Please try again later.");

  const state = randomToken(32);
  const verifier = randomToken(48);
  await db.query(
    `insert into public.oauth_states (state_hash, user_id, workspace_id, company_id, provider_id, code_verifier_ciphertext, external_account_id, expires_at, purpose, connection_id)
     values ($1, $2, $3, $4, $5, $6, $7, now() + interval '10 minutes', $8, $9)`,
    [sha256Hex(state), user.id, workspaceId, companyId, provider, encryptSecret(verifier, cfg.tokenEncryptionKey!, "oauth-verifier"), account, purpose, connectionId],
  );
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const auth = new URL(GOOGLE_AUTH_URL);
  auth.search = new URLSearchParams({
    client_id: cfg.google.clientId!,
    redirect_uri: cfg.google.redirectUri,
    response_type: "code",
    scope: purpose === "ga4_export" ? [GA4_SCOPE, GA4_EDIT_SCOPE, GA4_MANAGE_USERS_SCOPE].join(" ") : provider === "ga4" ? GA4_SCOPE : provider === "google_search_console" ? GSC_SCOPE : GOOGLE_ADS_SCOPE,
    access_type: "offline",
    prompt: "consent select_account",
    include_granted_scopes: "false",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  }).toString();
  return NextResponse.redirect(auth.toString());
}
