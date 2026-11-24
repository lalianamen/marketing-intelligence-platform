import type { EmailOtpType } from "@supabase/supabase-js";
import { loadConfig } from "@/server/config";
import { type NextRequest, NextResponse } from "next/server";
import { supabaseServer } from "@/server/supabase/server";

// Email confirmation / password recovery (token_hash flow, works across browsers).
export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const tokenHash = url.searchParams.get("token_hash");
  const type = url.searchParams.get("type") as EmailOtpType | null;
  const nextParam = url.searchParams.get("next") ?? "/app/companies";
  // Only allow same-site relative redirects.
  const next = nextParam.startsWith("/") && !nextParam.startsWith("//") ? nextParam : "/app/companies";
  // Default Supabase email templates (hosted projects) redirect here with a PKCE `code`.
  const code = url.searchParams.get("code");
  if (code) {
    const supabase = await supabaseServer();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) return NextResponse.redirect(new URL(next, loadConfig().appUrl));
  }
  if (tokenHash && (type === "email" || type === "recovery" || type === "signup")) {
    const supabase = await supabaseServer();
    const { error } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type });
    if (!error) return NextResponse.redirect(new URL(next, loadConfig().appUrl));
  }
  return NextResponse.redirect(new URL("/login?error=" + encodeURIComponent("This link is invalid or has expired."), loadConfig().appUrl));
}
