"use client";

import { useActionState } from "react";
import { confirmCsvImportAction, type CsvPreviewState, uploadCsvAction } from "@/app/app/actions";
import { SubmitButton } from "./SubmitButton";

const initial: CsvPreviewState = { status: "idle" };

export function CsvUploader({ companyId, companyName }: { companyId: string; companyName: string }) {
  const [state, action, pending] = useActionState(uploadCsvAction, initial);
  return (
    <div className="space-y-5">
      <form action={action} className="space-y-3 rounded-xl border border-gray-200 bg-white p-5">
        <input type="hidden" name="company_id" value={companyId} />
        <label className="block">
          <span className="text-sm font-medium">CSV file for {companyName}</span>
          <input name="file" type="file" accept=".csv,text/csv" required className="mt-2 block w-full text-sm" />
          <span className="mt-1 block text-xs text-gray-500">Up to 5 MB and 50,000 rows. Dates are read as days in the company's time zone.</span>
        </label>
        <button disabled={pending} className="rounded-lg bg-brand-600 px-3.5 py-2 text-sm font-medium text-white disabled:opacity-50">
          {pending ? "Checking…" : "Check file"}
        </button>
      </form>

      {state.message && <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900">{state.message}</div>}

      {state.status !== "idle" && state.summary && (
        <div className="space-y-4 rounded-xl border border-gray-200 bg-white p-5" data-testid="csv-preview">
          <h2 className="text-base font-semibold">Review: {state.filename}</h2>
          {state.errors && state.errors.length > 0 && (
            <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-900">
              <p className="font-medium">We found {state.errors.length} problem(s). Nothing was imported. Fix the file and try again:</p>
              <ul className="mt-2 list-disc pl-5">
                {state.errors.slice(0, 30).map((e, i) => (
                  <li key={i}>{e.row !== null ? `Row ${e.row}` : "File"}{e.column ? `, column "${e.column}"` : ""}: {e.message}</li>
                ))}
              </ul>
            </div>
          )}
          {state.warnings && state.warnings.length > 0 && (
            <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">
              <ul className="list-disc pl-5">{state.warnings.slice(0, 20).map((w, i) => <li key={i}>{w.row !== null ? `Row ${w.row}: ` : ""}{w.message}</li>)}</ul>
            </div>
          )}
          <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
            <div><dt className="text-gray-500">Rows</dt><dd className="font-medium">{state.summary.rowCount.toLocaleString("en-US")}</dd></div>
            <div><dt className="text-gray-500">Dates</dt><dd className="font-medium">{state.summary.dateFrom ?? "—"} → {state.summary.dateTo ?? "—"}</dd></div>
            <div><dt className="text-gray-500">Sources</dt><dd className="font-medium">{state.summary.sources.join(", ") || "—"}</dd></div>
            <div><dt className="text-gray-500">Currencies</dt><dd className="font-medium">{state.summary.currencies.join(", ") || "—"}</dd></div>
          </dl>
          {Object.keys(state.summary.totals).length > 0 && (
            <p className="text-sm text-gray-700">Totals in file: {Object.entries(state.summary.totals).map(([k, v]) => `${k} ${v.toLocaleString("en-US")}`).join(" · ")}</p>
          )}
          {state.preview && (
            <div className="overflow-x-auto">
              <table className="text-xs">
                <tbody>
                  {state.preview.map((r, i) => (
                    <tr key={i} className={i === 0 ? "font-semibold" : ""}>{r.map((c, j) => <td key={j} className="border border-gray-100 px-2 py-1">{c}</td>)}</tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {state.uploadId && (
            <form action={confirmCsvImportAction} className="flex items-center gap-3">
              <input type="hidden" name="upload_id" value={state.uploadId} />
              <SubmitButton pendingText="Importing…">
                {state.status === "duplicate" ? "This exact file was uploaded before — import again" : "Import these rows"}
              </SubmitButton>
              <span className="text-xs text-gray-500">Re-importing replaces numbers for the same day, source and campaign. Nothing is double counted.</span>
            </form>
          )}
        </div>
      )}
    </div>
  );
}
