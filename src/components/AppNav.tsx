"use client";

import { usePathname } from "next/navigation";

const ITEMS = [
  { href: "/app", label: "Dashboard" },
  { href: "/app/companies", label: "Companies" },
  { href: "/app/connections", label: "Data Connections" },
  { href: "/app/analytics", label: "Analytics" },
  { href: "/app/settings", label: "Settings" },
];

export function AppNav() {
  const path = usePathname();
  return (
    <nav aria-label="Main" className="flex flex-wrap gap-1">
      {ITEMS.map((i) => {
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
  );
}
