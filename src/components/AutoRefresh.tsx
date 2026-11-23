"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/** Re-renders the server page every few seconds while background work is pending. */
export function AutoRefresh({ active, everyMs = 3000 }: { active: boolean; everyMs?: number }) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => router.refresh(), everyMs);
    return () => clearInterval(t);
  }, [active, everyMs, router]);
  return active ? <p className="text-xs text-gray-500" aria-live="polite">Updating automatically…</p> : null;
}
