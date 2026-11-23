import type { EmailOtpType } from "@supabase/supabase-js";
import { loadConfig } from "@/server/config";
import { type NextRequest, NextResponse } from "next/server";
import { supabaseServer } from "@/server/supabase/server";

// Email confirmation / password recovery (token_hash flow, works across browsers).
export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const tokenHash = url.searchParams.get("token_hash");
  const type = url.searchParams.get("type") as EmailOtpType | null;
  const nextParam = url.searchParams.get("next") ?? "/app";
  // Only allow same-site relative redirects.
  const next = nextParam.startsWith("/") && !nextParam.startsWith("//") ? nextParam : "/app";
  if (tokenHash && (type === "email" || type === "recovery" || type === "signup")) {
    const supabase = await supabaseServer();
    const { error } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type });
    if (!error) return NextResponse.redirect(new URL(next, loadConfig().appUrl));
  }
  return NextResponse.redirect(new URL("/login?error=" + encodeURIComponent("This link is invalid or has expired."), loadConfig().appUrl));
}
