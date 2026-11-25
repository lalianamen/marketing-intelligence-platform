"use client";

import { type ReactNode, useEffect, useState } from "react";

/** Shows its content full screen on demand (button or Esc to leave). */
export function Expandable({ title, children, storageKey = "raw-table-full" }: { title: string; children: ReactNode; storageKey?: string }) {
  const [full, setFullState] = useState(false);
  // Filters, sorting and paging reload the page: keep full screen across those reloads in this tab.
  useEffect(() => {
    try {
      if (sessionStorage.getItem(storageKey) === "1") setFullState(true);
    } catch {
      /* storage unavailable */
    }
  }, [storageKey]);
  const setFull = (next: boolean | ((v: boolean) => boolean)) =>
    setFullState((v) => {
      const value = typeof next === "function" ? next(v) : next;
      try {
        sessionStorage.setItem(storageKey, value ? "1" : "0");
      } catch {
        /* storage unavailable */
      }
      return value;
    });
  useEffect(() => {
    if (!full) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setFull(false);
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [full]);
  return (
    <div
      data-expanded={full ? "true" : "false"}
      className={full ? "raw-expanded fixed inset-0 z-50 overflow-auto bg-white p-4 sm:p-6" : ""}
      role={full ? "dialog" : undefined}
      aria-label={full ? title : undefined}
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        {full ? <h2 className="text-lg font-semibold">{title}</h2> : <span />}
        <button
          type="button"
          onClick={() => setFull((v) => !v)}
          className="rounded-md px-2.5 py-1 text-xs font-medium text-gray-700 ring-1 ring-gray-300 hover:bg-gray-50"
          data-testid="toggle-fullscreen"
        >
          {full ? "✕ Exit full screen (Esc)" : "⤢ Full screen"}
        </button>
      </div>
      {children}
    </div>
  );
}
