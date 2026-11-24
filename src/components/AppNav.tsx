"use client";

import { usePathname } from "next/navigation";

const COMPANY_ITEMS = [
  { href: "/app", label: "Overview" },
  { href: "/app/connections", label: "Data Connections" },
  { href: "/app/analytics", label: "Analytics" },
  { href: "/app/settings", label: "Settings" },
];

/**
 * Two levels: the Companies list (no company menu), and inside a company its
 * own menu with a way back to the list.
 */
export function AppNav({ company }: { company: { name: string } | null }) {
  const path = usePathname();
  const onList = path.startsWith("/app/companies");
  if (onList || !company) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
      <a href="/app/companies" className="text-sm text-gray-500 hover:text-gray-900">← All companies</a>
      <span className="text-lg font-semibold text-gray-900" data-testid="current-company">{company.name}</span>
      <nav aria-label="Company" className="flex flex-wrap gap-1">
        {COMPANY_ITEMS.map((i) => {
          const active = i.href === "/app" ? path === "/app" : path.startsWith(i.href);
          return (
            <a
              key={i.href}
              href={i.href}
              aria-current={active ? "page" : undefined}
              className={`rounded-lg px-3 py-2 text-sm font-medium ${active ? "bg-brand-50 text-brand-700" : "text-gray-600 hover:bg-gray-100"}`}
            >
              {i.label}
            </a>
          );
        })}
      </nav>
    </div>
  );
}
