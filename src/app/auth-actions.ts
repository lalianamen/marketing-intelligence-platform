"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getPool } from "@/server/db";
import { supabaseServer } from "@/server/supabase/server";
import { loadConfig } from "@/server/config";

async function clientIp(): Promise<string> {
  const h = await headers();
  return (h.get("x-forwarded-for")?.split(",")[0] ?? h.get("x-real-ip") ?? "local").trim().slice(0, 64);
}

async function allow(bucket: string, limit: number, windowSeconds: number): Promise<boolean> {
  const r = await getPool().query<{ ok: boolean }>("select private.rate_limit_hit($1, $2, $3) as ok", [bucket, limit, windowSeconds]);
  return r.rows[0]?.ok ?? false;
}

function back(path: string, params: Record<string, string>): never {
  redirect(`${path}?${new URLSearchParams(params).toString()}`);
}

export async function signUpAction(form: FormData): Promise<void> {
  const email = String(form.get("email") ?? "").trim().toLowerCase();
  const password = String(form.get("password") ?? "");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) back("/signup", { error: "Please enter a valid email address." });
  if (password.length < 10 || !/[a-zA-Z]/.test(password) || !/\d/.test(password))
    back("/signup", { error: "Use at least 10 characters with letters and numbers." });
  if (!(await allow(`signup:ip:${await clientIp()}`, 5, 3600))) back("/signup", { error: "Too many sign-up attempts. Please try again later." });
  const supabase = await supabaseServer();
  const { error } = await supabase.auth.signUp({
    email,
    password,
    options: { emailRedirectTo: `${loadConfig().appUrl}/auth/confirm` },
  });
  // Same response whether or not the email already exists (no account enumeration).
  if (error && !/already registered/i.test(error.message)) back("/signup", { error: "Sign-up failed. Please try again." });
  redirect(`/check-email?email=${encodeURIComponent(email)}`);
}

export async function signInAction(form: FormData): Promise<void> {
  const email = String(form.get("email") ?? "").trim().toLowerCase();
  const password = String(form.get("password") ?? "");
  if (!(await allow(`signin:ip:${await clientIp()}`, 30, 300))) back("/login", { error: "Too many attempts. Please wait a few minutes." });
  const supabase = await supabaseServer();
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) {
    if (/not confirmed/i.test(error.message)) redirect(`/check-email?email=${encodeURIComponent(email)}`);
    back("/login", { error: "Email or password is incorrect." });
  }
  redirect("/app");
}

export async function forgotPasswordAction(form: FormData): Promise<void> {
  const email = String(form.get("email") ?? "").trim().toLowerCase();
  if (await allow(`reset:ip:${await clientIp()}`, 5, 3600)) {
    const supabase = await supabaseServer();
    await supabase.auth.resetPasswordForEmail(email, { redirectTo: `${loadConfig().appUrl}/auth/confirm?next=/reset-password` });
  }
  back("/forgot-password", { sent: "1" });
}

export async function resetPasswordAction(form: FormData): Promise<void> {
  const password = String(form.get("password") ?? "");
  if (password.length < 10 || !/[a-zA-Z]/.test(password) || !/\d/.test(password))
    back("/reset-password", { error: "Use at least 10 characters with letters and numbers." });
  const supabase = await supabaseServer();
  const { error } = await supabase.auth.updateUser({ password });
  if (error) back("/reset-password", { error: "The reset link has expired. Request a new one." });
  redirect("/app?password=updated");
}

export async function resendConfirmationAction(form: FormData): Promise<void> {
  const email = String(form.get("email") ?? "").trim().toLowerCase();
  if (await allow(`resend:ip:${await clientIp()}`, 5, 3600)) {
    const supabase = await supabaseServer();
    await supabase.auth.resend({ type: "signup", email, options: { emailRedirectTo: `${loadConfig().appUrl}/auth/confirm` } });
  }
  redirect(`/check-email?email=${encodeURIComponent(email)}&resent=1`);
}
