import type { ReactNode } from "react";

export function AuthShell({ title, children, footer }: { title: string; children: ReactNode; footer?: ReactNode }) {
  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-12">
      <div className="w-full max-w-md">
        <p className="mb-6 text-center text-sm font-semibold tracking-wide text-brand-700">MARKETING INTELLIGENCE</p>
        <div className="rounded-2xl border border-gray-200 bg-white p-8 shadow-sm">
          <h1 className="mb-6 text-xl font-semibold text-gray-900">{title}</h1>
          {children}
        </div>
        {footer && <div className="mt-6 text-center text-sm text-gray-600">{footer}</div>}
      </div>
    </main>
  );
}
