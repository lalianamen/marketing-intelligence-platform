import type { ReactNode } from "react";
import { getAppContext } from "@/server/appContext";
import { AppNav } from "@/components/AppNav";
import { CompanySwitcher } from "@/components/CompanySwitcher";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: ReactNode }) {
  const ctx = await getAppContext();
  return (
    <div className="min-h-screen">
      <header className="border-b border-gray-200 bg-white">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3 px-4 py-3">
          <div className="flex items-center gap-4">
            <a href="/app" className="text-sm font-semibold tracking-wide text-brand-700">MARKETING INTELLIGENCE</a>
            <span className="hidden text-xs text-gray-500 sm:inline" title="Workspace">{ctx.workspace.name}</span>
          </div>
          <div className="flex items-center gap-4">
            <CompanySwitcher companies={ctx.companies} currentId={ctx.company?.id ?? null} />
            <form action="/auth/signout" method="post">
              <button className="text-sm text-gray-600 hover:text-gray-900">Log out</button>
            </form>
          </div>
        </div>
        <div className="mx-auto max-w-7xl px-4 pb-2">
          <AppNav />
        </div>
      </header>
      <main className="mx-auto max-w-7xl px-4 py-6">{children}</main>
      <footer className="mx-auto max-w-7xl px-4 pb-8 text-xs text-gray-400">Phase 1 · local development build · not deployed</footer>
    </div>
  );
}
