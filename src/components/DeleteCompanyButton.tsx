"use client";

import { useRef, useState } from "react";
import { clearCompanyDataAction, deleteCompanyAction } from "@/app/app/actions";
import { SubmitButton } from "./SubmitButton";

const MODES = {
  delete: {
    action: deleteCompanyAction,
    button: "Delete company",
    title: (n: string) => `Delete “${n}”?`,
    lead: "All data of this company will be permanently deleted from the database.",
    tail: "This cannot be undone. Other companies are not affected.",
    confirm: "Delete company and its data",
    pending: "Deleting…",
  },
  clear: {
    action: clearCompanyDataAction,
    button: "Clear all data",
    title: (n: string) => `Clear all data of “${n}”?`,
    lead: "All data of this company will be permanently deleted from the database. The company itself stays, empty.",
    tail: "This cannot be undone. You can connect sources and upload files again afterwards.",
    confirm: "Clear all data",
    pending: "Clearing…",
  },
} as const;

/** Danger action with a confirmation dialog that warns the data is removed from the database. */
export function DeleteCompanyButton({ companyId, companyName, mode = "delete" }: { companyId: string; companyName: string; mode?: keyof typeof MODES }) {
  const m = MODES[mode];
  const dialog = useRef<HTMLDialogElement>(null);
  const [typed, setTyped] = useState("");
  const matches = typed.trim().toLowerCase() === companyName.trim().toLowerCase();
  return (
    <>
      <button
        type="button"
        onClick={() => {
          setTyped("");
          dialog.current?.showModal();
        }}
        className="rounded-lg px-3 py-2 text-sm font-medium text-red-700 ring-1 ring-red-200 hover:bg-red-50"
      >
        {m.button}
      </button>
      <dialog
        ref={dialog}
        aria-labelledby="delete-company-title"
        className="m-auto w-[min(32rem,calc(100vw-2rem))] rounded-xl p-0 shadow-xl backdrop:bg-black/40"
      >
        <form action={m.action} className="space-y-4 p-6">
          <input type="hidden" name="company_id" value={companyId} />
          <h2 id="delete-company-title" className="text-lg font-semibold text-gray-900">
            {m.title(companyName)}
          </h2>
          <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-900">
            <p className="font-semibold">{m.lead}</p>
            <ul className="mt-2 list-disc space-y-1 pl-5">
              <li>its private data space with every imported and synced number</li>
              <li>uploaded CSV files and import history</li>
              <li>connections and stored sign-ins</li>
            </ul>
            <p className="mt-2">{m.tail}</p>
          </div>
          <label className="block">
            <span className="text-sm font-medium text-gray-800">
              Type <span className="font-semibold">{companyName}</span> to confirm
            </span>
            <input
              name="confirm_name"
              required
              autoComplete="off"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
            />
          </label>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => dialog.current?.close()} className="rounded-lg px-3.5 py-2 text-sm font-medium text-gray-700 ring-1 ring-gray-300 hover:bg-gray-50">
              Cancel
            </button>
            <SubmitButton pendingText={m.pending} variant="danger" disabled={!matches}>
              {m.confirm}
            </SubmitButton>
          </div>
        </form>
      </dialog>
    </>
  );
}
