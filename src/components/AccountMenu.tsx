"use client";

import { useEffect, useRef } from "react";

/** Header account menu: shows who is signed in, with account settings and log out. Closes on outside click or Escape. */
export function AccountMenu({ email, workspace }: { email: string; workspace: string }) {
  const initial = (email[0] ?? "?").toUpperCase();
  const ref = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const close = (e: Event) => {
      const el = ref.current;
      if (!el?.open) return;
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !el.contains(e.target as Node)) el.open = false;
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", close);
    };
  }, []);
  return (
    <details ref={ref} className="group relative" data-testid="account-menu">
      <summary className="flex cursor-pointer list-none items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-gray-100 [&::-webkit-details-marker]:hidden">
        <span className="flex h-7 w-7 items-center justify-center rounded-full bg-brand-600 text-xs font-semibold text-white" aria-hidden>{initial}</span>
        <span className="hidden max-w-56 truncate text-sm text-gray-700 sm:inline">{email}</span>
        <span className="text-xs text-gray-400" aria-hidden>▾</span>
      </summary>
      <div className="absolute right-0 z-20 mt-2 w-64 rounded-xl border border-gray-200 bg-white p-2 shadow-lg">
        <div className="border-b border-gray-100 px-3 pb-2 pt-1">
          <p className="text-xs text-gray-500">Signed in as</p>
          <p className="truncate text-sm font-medium text-gray-900">{email}</p>
          <p className="truncate text-xs text-gray-500">Workspace: {workspace}</p>
        </div>
        <a href="/app/account" className="mt-1 block rounded-lg px-3 py-2 text-sm text-gray-700 hover:bg-gray-100">Account settings</a>
        <a href="/app/account#users" className="block rounded-lg px-3 py-2 text-sm text-gray-700 hover:bg-gray-100">Users and access</a>
        <a href="/app/companies" className="block rounded-lg px-3 py-2 text-sm text-gray-700 hover:bg-gray-100">All companies</a>
        <form action="/auth/signout" method="post">
          <button className="block w-full rounded-lg px-3 py-2 text-left text-sm text-gray-700 hover:bg-gray-100">Log out</button>
        </form>
      </div>
    </details>
  );
}
