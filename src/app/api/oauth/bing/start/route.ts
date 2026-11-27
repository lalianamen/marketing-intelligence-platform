import { type NextRequest, NextResponse } from "next/server";
import { getUser } from "@/server/supabase/server";
import { getPool } from "@/server/db";
import { bingOAuthConfigured, loadConfig } from "@/server/config";
import { requireCompanyAccess } from "@/server/auth/authz";
import { encryptSecret, randomToken, sha256Hex } from "@/server/crypto";
import { BING_AUTH_URL, BING_SCOPE } from "@/server/connectors/bing";

// Starts Bing's own consent screen ("Sign in with Bing", authorization code + state).
// The user never types a password or key into this app.
export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const cfg = loadConfig();
  const back = (msg: string) => NextResponse.redirect(new URL(`/app/connections?oauth=${encodeURIComponent(msg)}`, cfg.appUrl));
  if (!bingOAuthConfigured(cfg)) return NextResponse.redirect(new URL("/app/connections/bing", cfg.appUrl));
  const { user } = await getUser();
  if (!user) return NextResponse.redirect(new URL("/login", cfg.appUrl));
  const companyId = url.searchParams.get("company") ?? "";
  const db = getPool();
  let workspaceId: string;
  try {
    ({ workspaceId } = await requireCompanyAccess(db, user.id, companyId, "manage"));
  } catch {
    return back("Not found, or you do not have access.");
  }
  const rl = await db.query<{ ok: boolean }>("select private.rate_limit_hit($1, 10, 3600) as ok", [`oauth:${user.id}`]);
  if (!rl.rows[0]?.ok) return back("Too many attempts. Please try again later.");

  const state = randomToken(32);
  // Bing's OAuth has no PKCE; the column still gets a random, unused value.
  await db.query(
    `insert into public.oauth_states (state_hash, user_id, workspace_id, company_id, provider_id, code_verifier_ciphertext, external_account_id, expires_at)
     values ($1, $2, $3, $4, 'bing_webmaster', $5, '', now() + interval '10 minutes')`,
    [sha256Hex(state), user.id, workspaceId, companyId, encryptSecret(randomToken(16), cfg.tokenEncryptionKey!, "oauth-verifier")],
  );
  const auth = new URL(BING_AUTH_URL);
  auth.search = new URLSearchParams({
    response_type: "code",
    client_id: cfg.bing.clientId!,
    redirect_uri: cfg.bing.redirectUri,
    scope: BING_SCOPE,
    state,
  }).toString();
  return NextResponse.redirect(auth.toString());
}
