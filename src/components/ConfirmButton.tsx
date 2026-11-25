"use client";

import { type ReactNode, useRef } from "react";
import { SubmitButton } from "./SubmitButton";

/** A button that asks for confirmation in a dialog before running a server action. */
export function ConfirmButton({
  action,
  fields,
  label,
  title,
  lines,
  confirmLabel,
  pendingLabel,
  danger = true,
  trigger,
  triggerClassName,
  triggerLabel,
}: {
  action: (form: FormData) => Promise<void>;
  fields: Record<string, string>;
  label: string;
  title: string;
  lines: string[];
  confirmLabel: string;
  pendingLabel: string;
  danger?: boolean;
  /** Custom look for the opening button (e.g. a switch). */
  trigger?: ReactNode;
  triggerClassName?: string;
  triggerLabel?: string;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  return (
    <>
      <button
        type="button"
        onClick={() => dialog.current?.showModal()}
        aria-label={triggerLabel}
        className={triggerClassName ?? `rounded-lg px-3.5 py-2 text-sm font-medium ring-1 ${danger ? "text-red-700 ring-red-200 hover:bg-red-50" : "text-gray-800 ring-gray-300 hover:bg-gray-50"}`}
      >
        {trigger ?? label}
      </button>
      <dialog ref={dialog} className="m-auto w-[min(30rem,calc(100vw-2rem))] rounded-xl p-0 shadow-xl backdrop:bg-black/40">
        <form action={action} className="space-y-4 p-6">
          {Object.entries(fields).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
          <h2 className="text-lg font-semibold text-gray-900">{title}</h2>
          <div className={`space-y-1 rounded-lg border p-3 text-sm ${danger ? "border-red-200 bg-red-50 text-red-900" : "border-gray-200 bg-gray-50 text-gray-800"}`}>
            {lines.map((l) => <p key={l}>{l}</p>)}
          </div>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => dialog.current?.close()} className="rounded-lg px-3.5 py-2 text-sm font-medium text-gray-700 ring-1 ring-gray-300 hover:bg-gray-50">
              Cancel
            </button>
            <SubmitButton pendingText={pendingLabel} variant={danger ? "danger" : "primary"}>{confirmLabel}</SubmitButton>
          </div>
        </form>
      </dialog>
    </>
  );
}
