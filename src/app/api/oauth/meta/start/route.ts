import { type NextRequest, NextResponse } from "next/server";
import { getUser } from "@/server/supabase/server";
import { getPool } from "@/server/db";
import { loadConfig, metaOAuthConfigured } from "@/server/config";
import { requireCompanyAccess } from "@/server/auth/authz";
import { encryptSecret, randomToken, sha256Hex } from "@/server/crypto";
import { metaDialogUrl } from "@/server/connectors/meta";

// Starts Facebook's own sign-in screen (authorization code + state).
// The user never types a password or key into this app.
export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const cfg = loadConfig();
  const back = (msg: string) => NextResponse.redirect(new URL(`/app/connections?oauth=${encodeURIComponent(msg)}`, cfg.appUrl));
  if (!metaOAuthConfigured(cfg)) return back("Facebook connections are not configured by the administrator yet.");
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
  await db.query(
    `insert into public.oauth_states (state_hash, user_id, workspace_id, company_id, provider_id, code_verifier_ciphertext, external_account_id, expires_at)
     values ($1, $2, $3, $4, 'meta_ads', $5, '', now() + interval '10 minutes')`,
    [sha256Hex(state), user.id, workspaceId, companyId, encryptSecret(randomToken(16), cfg.tokenEncryptionKey!, "oauth-verifier")],
  );
  return NextResponse.redirect(
    metaDialogUrl({ appId: cfg.meta.appId!, appSecret: cfg.meta.appSecret!, apiVersion: cfg.meta.apiVersion, redirectUri: cfg.meta.redirectUri, configId: cfg.meta.configId }, state),
  );
}
