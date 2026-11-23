import { type NextRequest, NextResponse } from "next/server";
import { loadConfig } from "@/server/config";
import { supabaseServer } from "@/server/supabase/server";

export async function POST(request: NextRequest) {
  const supabase = await supabaseServer();
  await supabase.auth.signOut();
  return NextResponse.redirect(new URL("/login", loadConfig().appUrl), { status: 303 });
}
