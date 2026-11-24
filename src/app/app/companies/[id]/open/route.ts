import { type NextRequest, NextResponse } from "next/server";
import { COMPANY_COOKIE } from "@/server/appContext";
import { loadConfig } from "@/server/config";
import { getUser } from "@/server/supabase/server";

// Opens a company: remembers it as the selected company and goes to its overview.
// The id is checked through the RLS-scoped client, so a foreign id is just "not found".
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const base = loadConfig().appUrl;
  const { supabase, user } = await getUser();
  if (!user) return NextResponse.redirect(new URL("/login", base));
  const { data } = /^[0-9a-f-]{36}$/i.test(id)
    ? await supabase.from("companies").select("id").eq("id", id).eq("status", "active").maybeSingle()
    : { data: null };
  if (!data) return NextResponse.redirect(new URL("/app/companies?error=" + encodeURIComponent("Not found, or you do not have access."), base));
  const res = NextResponse.redirect(new URL("/app", base));
  res.cookies.set(COMPANY_COOKIE, data.id, { httpOnly: true, sameSite: "lax", path: "/", secure: process.env.NODE_ENV === "production" });
  return res;
}
