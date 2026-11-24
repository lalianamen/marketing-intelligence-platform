"use client";

import type { ReactNode } from "react";
import { useFormStatus } from "react-dom";

/** Submit button that disables itself while its form is being sent, so a double click cannot submit twice. */
export function SubmitButton({ children, pendingText, variant = "primary" }: { children: ReactNode; pendingText?: string; variant?: "primary" | "danger" }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      aria-busy={pending}
      className={`inline-flex items-center justify-center rounded-lg px-3.5 py-2 text-sm font-medium disabled:opacity-50 ${
        variant === "danger" ? "bg-red-600 text-white hover:bg-red-700" : "bg-brand-600 text-white hover:bg-brand-700"
      }`}
    >
      {pending ? (pendingText ?? "Working…") : children}
    </button>
  );
}
