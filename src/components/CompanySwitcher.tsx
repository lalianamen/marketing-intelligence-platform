"use client";

import { usePathname } from "next/navigation";
import { selectCompanyAction } from "@/app/app/actions";

export function CompanySwitcher({ companies, currentId }: { companies: { id: string; name: string }[]; currentId: string | null }) {
  const back = usePathname();
  if (companies.length === 0) return null;
  return (
    <form action={selectCompanyAction} className="flex items-center gap-2">
      <label htmlFor="company-switcher" className="text-xs font-medium text-gray-500">Company</label>
      <input type="hidden" name="back" value={back} />
      <select
        id="company-switcher"
        name="company_id"
        defaultValue={currentId ?? undefined}
        onChange={(e) => e.currentTarget.form?.requestSubmit()}
        className="rounded-lg border border-gray-300 bg-white px-2 py-1.5 text-sm"
      >
        {companies.map((c) => (
          <option key={c.id} value={c.id}>{c.name}</option>
        ))}
      </select>
      <noscript><button className="text-sm">Switch</button></noscript>
    </form>
  );
}
