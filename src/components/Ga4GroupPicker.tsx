"use client";

import { useRef, useState } from "react";
import { GA4_MAX_DIMENSIONS, GA4_MAX_METRICS, type Ga4Group, ga4Fields, ga4SelectionProblem } from "@/lib/ga4Catalog";
import { SubmitButton } from "./SubmitButton";

/**
 * Choose GA4 data groups as a draft: switches change nothing until Save.
 * After the first load, Save asks for confirmation, because a real change
 * deletes the connector's data and loads the last 30 days again.
 */
export function Ga4GroupPicker({
  action,
  connectionId,
  groups,
  saved,
  canManage,
  reloadOnSave,
}: {
  action: (form: FormData) => Promise<void>;
  connectionId: string;
  groups: Ga4Group[];
  saved: string[];
  canManage: boolean;
  reloadOnSave: boolean;
}) {
  const [draft, setDraft] = useState<string[]>(saved);
  const dialog = useRef<HTMLDialogElement>(null);
  const added = draft.filter((g) => !saved.includes(g));
  const removed = saved.filter((g) => !draft.includes(g));
  const dirty = added.length + removed.length > 0;
  const fields = ga4Fields(draft);
  const title = (id: string) => groups.find((g) => g.id === id)?.title ?? id;
  const toggle = (id: string) => setDraft((d) => (d.includes(id) ? d.filter((x) => x !== id) : [...d, id]));

  return (
    <form action={action} data-testid="ga4-picker">
      <input type="hidden" name="connection_id" value={connectionId} />
      {draft.map((g) => <input key={g} type="hidden" name="group" value={g} />)}

      <div className="mt-4 grid gap-4 md:grid-cols-2">
        {groups.map((g) => {
          const on = Boolean(g.core) || draft.includes(g.id);
          const blocked = !on ? ga4SelectionProblem([...draft, g.id]) : null;
          const pending = added.includes(g.id) || removed.includes(g.id);
          return (
            <section key={g.id} className={`rounded-lg border p-3 ${on ? "border-green-200 bg-green-50/40" : "border-gray-100"} ${pending ? "ring-2 ring-amber-300" : ""}`} data-testid={`ga4-report-${g.id}`}>
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h3 className="text-sm font-semibold text-gray-900">{g.title}</h3>
                  <p className="text-xs text-gray-600">{g.summary}</p>
                </div>
                {g.core ? (
                  <span className="rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-800">always on</span>
                ) : blocked ? (
                  <span title={blocked} className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-700">limit reached</span>
                ) : canManage ? (
                  <button
                    type="button"
                    role="switch"
                    aria-checked={on}
                    aria-label={`${g.title}`}
                    onClick={() => toggle(g.id)}
                    className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition ${on ? "bg-green-600" : "bg-gray-300"}`}
                  >
                    <span className={`inline-block h-5 w-5 rounded-full bg-white shadow transition ${on ? "translate-x-5" : "translate-x-0.5"}`} />
                  </button>
                ) : (
                  <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-700">{on ? "on" : "off"}</span>
                )}
              </div>
              {pending && <p className="mt-1 text-xs font-medium text-amber-800">{added.includes(g.id) ? "Will be added when you save" : "Will be removed when you save"}</p>}
              {g.note && <p className="mt-1 text-xs text-amber-800">{g.note}</p>}
              {blocked && <p className="mt-1 text-xs text-gray-500">{blocked}</p>}
              {g.dimensions.length + g.metrics.length > 0 && (
                <ul className="mt-2 space-y-1 text-xs">
                  {[...g.dimensions, ...g.metrics].map((f) => (
                    <li key={f.name} className="flex gap-2">
                      <code className="shrink-0 font-mono text-gray-800">{f.name}</code>
                      <span className="text-gray-600">{f.description}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          );
        })}
      </div>

      {canManage && (
        <div className="sticky bottom-0 mt-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-gray-200 bg-white/95 p-3 text-sm shadow-sm" data-testid="ga4-picker-bar">
          <p className="text-gray-700">
            {fields.dimensions.length} of {GA4_MAX_DIMENSIONS} breakdowns · {fields.metrics.length} of {GA4_MAX_METRICS} numbers
            {dirty ? (
              <span className="ml-2 font-medium text-amber-800">
                Unsaved changes{added.length ? ` · add: ${added.map(title).join(", ")}` : ""}{removed.length ? ` · remove: ${removed.map(title).join(", ")}` : ""}
              </span>
            ) : (
              <span className="ml-2 text-gray-500">No changes</span>
            )}
          </p>
          <div className="flex gap-2">
            <button type="button" disabled={!dirty} onClick={() => setDraft(saved)} className="rounded-lg px-3.5 py-2 font-medium text-gray-700 ring-1 ring-gray-300 hover:bg-gray-50 disabled:opacity-40">
              Undo changes
            </button>
            {reloadOnSave ? (
              <button type="button" disabled={!dirty} onClick={() => dialog.current?.showModal()} className="rounded-lg bg-gray-900 px-3.5 py-2 font-medium text-white hover:bg-gray-800 disabled:opacity-40">
                Save and reload…
              </button>
            ) : (
              <SubmitButton pendingText="Saving…" disabled={!dirty}>Save</SubmitButton>
            )}
          </div>
        </div>
      )}

      {reloadOnSave && (
        <dialog ref={dialog} className="m-auto w-[min(32rem,calc(100vw-2rem))] rounded-xl p-0 shadow-xl backdrop:bg-black/40">
          <div className="space-y-4 p-6">
            <h2 className="text-lg font-semibold text-gray-900">Save the new set of data and reload?</h2>
            <div className="space-y-1 rounded-lg border border-gray-200 bg-gray-50 p-3 text-sm text-gray-800">
              {added.length > 0 && <p>Add: {added.map(title).join(", ")}</p>}
              {removed.length > 0 && <p>Remove: {removed.map(title).join(", ")}</p>}
            </div>
            <div className="space-y-1 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-900">
              <p>The whole current table of this connector will be deleted — from the database and from the table, including the dashboard numbers.</p>
              <p>A new load then starts from scratch with the new set of columns, for the last 30 days only.</p>
              <p>Loading the new table takes time. Until it finishes, the table and the dashboard show only the days loaded so far. Older days can be added afterwards with Load history.</p>
            </div>
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => dialog.current?.close()} className="rounded-lg px-3.5 py-2 text-sm font-medium text-gray-700 ring-1 ring-gray-300 hover:bg-gray-50">
                Cancel
              </button>
              <SubmitButton pendingText="Restarting…" variant="danger">Delete table and reload</SubmitButton>
            </div>
          </div>
        </dialog>
      )}
    </form>
  );
}
