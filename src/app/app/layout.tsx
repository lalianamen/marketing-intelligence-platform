import type { ReactNode } from "react";
import { getAppContext } from "@/server/appContext";
import { AppNav } from "@/components/AppNav";
import { AccountMenu } from "@/components/AccountMenu";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: ReactNode }) {
  const ctx = await getAppContext();
  return (
    <div className="min-h-screen">
      <header className="border-b border-gray-200 bg-white">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3 px-4 py-3">
          <div className="flex items-center gap-4">
            <a href="/app/companies" className="text-sm font-semibold tracking-wide text-brand-700">MARKETING INTELLIGENCE</a>
            <span className="hidden text-xs text-gray-500 sm:inline" title="Workspace">{ctx.workspace.name}</span>
          </div>
          <div className="flex items-center gap-4">
            <a href="/app/companies" className="text-sm text-gray-600 hover:text-gray-900">Companies</a>
            <AccountMenu email={ctx.email} workspace={ctx.workspace.name} />
          </div>
        </div>
        <div className="mx-auto max-w-7xl px-4 empty:hidden [&:has(>*)]:pb-2">
          <AppNav company={ctx.company ? { id: ctx.company.id, name: ctx.company.name } : null} canDelete={["owner", "admin"].includes(ctx.workspace.role)} />
        </div>
      </header>
      <main className="mx-auto max-w-7xl px-4 py-6">{children}</main>
      <footer className="mx-auto max-w-7xl px-4 pb-8 text-xs text-gray-400">Phase 1 · early access</footer>
    </div>
  );
}
