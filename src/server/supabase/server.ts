import "server-only";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import type { SupabaseClient, User } from "@supabase/supabase-js";

// User-scoped Supabase client (RLS enforced). Uses the publishable/anon key only.
export async function supabaseServer(): Promise<SupabaseClient> {
  const store = await cookies();
  return createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    cookies: {
      getAll: () => store.getAll(),
      setAll: (items) => {
        try {
          for (const { name, value, options } of items) store.set(name, value, options);
        } catch {
          // Called from a Server Component: the proxy refreshes the session cookie instead.
        }
      },
    },
  });
}

/** Verified user (validated against Supabase Auth, not just the cookie). */
export async function getUser(): Promise<{ supabase: SupabaseClient; user: User | null }> {
  const supabase = await supabaseServer();
  const { data } = await supabase.auth.getUser();
  return { supabase, user: data.user ?? null };
}
