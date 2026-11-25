"use client";

import { useRef, useState } from "react";
import { GA4_MAX_DIMENSIONS, GA4_MAX_METRICS, type Ga4Group, ga4Fields, ga4SelectionProblem, sanitizeGa4Selection } from "@/lib/ga4Catalog";
import { SubmitButton } from "./SubmitButton";

/**
 * Choose GA4 columns as a draft — a whole group with its switch or single fields
 * with their boxes; nothing changes until Save.
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
  const toggleField = (name: string) => setDraft((d) => sanitizeGa4Selection(d.includes(name) ? d.filter((x) => x !== name) : [...d, name]));
  const groupNames = (g: Ga4Group) => [...g.dimensions, ...g.metrics].map((f) => f.name);
  const toggleGroup = (g: Ga4Group, allOn: boolean) =>
    setDraft((d) => sanitizeGa4Selection(allOn ? d.filter((x) => !groupNames(g).includes(x)) : [...d, ...groupNames(g)]));

  return (
    <form action={action} data-testid="ga4-picker">
      <input type="hidden" name="connection_id" value={connectionId} />
      {draft.map((f) => <input key={f} type="hidden" name="field" value={f} />)}

      <div className="mt-4 grid gap-4 md:grid-cols-2">
        {groups.map((g) => {
          const names = groupNames(g);
          const onCount = g.core ? names.length : names.filter((n) => draft.includes(n)).length;
          const allOn = onCount === names.length;
          const missing = names.filter((n) => !draft.includes(n));
          const groupBlocked = !g.core && !allOn ? ga4SelectionProblem([...draft, ...missing]) : null;
          const pending = names.some((n) => added.includes(n) || removed.includes(n));
          return (
            <section key={g.id} className={`rounded-lg border p-3 ${onCount > 0 ? "border-green-200 bg-green-50/40" : "border-gray-100"} ${pending ? "ring-2 ring-amber-300" : ""}`} data-testid={`ga4-report-${g.id}`}>
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h3 className="text-sm font-semibold text-gray-900">{g.title}</h3>
                  <p className="text-xs text-gray-600">{g.summary}</p>
                </div>
                {g.core ? (
                  <span className="rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-800">always on</span>
                ) : canManage ? (
                  <div className="flex shrink-0 items-center gap-2">
                    {onCount > 0 && !allOn && <span className="text-xs text-gray-600">{onCount} of {names.length}</span>}
                    <button
                      type="button"
                      role="switch"
                      aria-checked={allOn}
                      aria-label={g.title}
                      title={groupBlocked ?? (allOn ? "Remove the whole group" : "Add the whole group")}
                      disabled={Boolean(groupBlocked)}
                      onClick={() => toggleGroup(g, allOn)}
                      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition disabled:opacity-40 ${allOn ? "bg-green-600" : onCount > 0 ? "bg-green-300" : "bg-gray-300"}`}
                    >
                      <span className={`inline-block h-5 w-5 rounded-full bg-white shadow transition ${allOn ? "translate-x-5" : onCount > 0 ? "translate-x-3" : "translate-x-0.5"}`} />
                    </button>
                  </div>
                ) : (
                  <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-700">{onCount} of {names.length}</span>
                )}
              </div>
              {g.note && <p className="mt-1 text-xs text-amber-800">{g.note}</p>}
              <ul className="mt-2 space-y-1 text-xs">
                {[...g.dimensions, ...g.metrics].map((f) => {
                  const on = Boolean(g.core) || draft.includes(f.name);
                  const blocked = !on ? ga4SelectionProblem([...draft, f.name]) : null;
                  const change = added.includes(f.name) ? "will be added" : removed.includes(f.name) ? "will be removed" : null;
                  return (
                    <li key={f.name}>
                      <label className={`flex items-start gap-2 ${g.core || !canManage || blocked ? "" : "cursor-pointer"}`} title={blocked ?? undefined}>
                        <input
                          type="checkbox"
                          className="mt-0.5"
                          checked={on}
                          disabled={Boolean(g.core) || !canManage || Boolean(blocked)}
                          onChange={() => toggleField(f.name)}
                          aria-label={f.name}
                        />
                        <code className={`shrink-0 font-mono ${on ? "text-gray-900" : "text-gray-500"}`}>{f.name}</code>
                        <span className="text-gray-600">
                          {f.description}
                          {change && <span className="ml-1 font-medium text-amber-800">({change})</span>}
                          {blocked && <span className="ml-1 text-gray-500">(limit reached)</span>}
                        </span>
                      </label>
                    </li>
                  );
                })}
              </ul>
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
                Unsaved changes{added.length ? ` · add: ${added.join(", ")}` : ""}{removed.length ? ` · remove: ${removed.join(", ")}` : ""}
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
              {added.length > 0 && <p>Add: {added.join(", ")}</p>}
              {removed.length > 0 && <p>Remove: {removed.join(", ")}</p>}
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
