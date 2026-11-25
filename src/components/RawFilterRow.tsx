"use client";

import { useEffect, useState } from "react";

const OPS = [
  { op: "contains", label: "contains" },
  { op: "eq", label: "equals" },
  { op: "gt", label: ">" },
  { op: "lt", label: "<" },
];
const OTHER = "__other__";

/** One filter: column, condition and a value picked from the values that exist in that column. */
export function RawFilterRow({
  n,
  columns,
  valuesUrl,
  initial,
  initialValues,
}: {
  n: number;
  columns: string[];
  valuesUrl: string;
  initial: { col: string; op: string; value: string };
  initialValues: string[];
}) {
  const [col, setCol] = useState(initial.col);
  const [op, setOp] = useState(initial.op || "eq");
  const [value, setValue] = useState(initial.value);
  const [values, setValues] = useState<string[] | null>(initial.col ? initialValues : null);
  const [custom, setCustom] = useState(Boolean(initial.value) && !initialValues.includes(initial.value));
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!col || (col === initial.col && values !== null)) return;
    let cancelled = false;
    setLoading(true);
    fetch(`${valuesUrl}${valuesUrl.includes("?") ? "&" : "?"}col=${encodeURIComponent(col)}`)
      .then((r) => (r.ok ? r.json() : { values: [] }))
      .then((j: { values?: string[] }) => {
        if (!cancelled) setValues(j.values ?? []);
      })
      .catch(() => !cancelled && setValues([]))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [col]);

  const numeric = op === "gt" || op === "lt";
  const useList = !numeric && !custom && values !== null && values.length > 0;

  return (
    <div className="flex flex-wrap items-center gap-2" data-testid={`filter-row-${n}`}>
      <span className="w-12 font-medium text-gray-700">{n === 1 ? "Filter" : "and"}</span>
      <select
        name={`f${n}c`}
        value={col}
        onChange={(e) => {
          setCol(e.target.value);
          setValue("");
          setCustom(false);
          setValues(null);
        }}
        className="rounded border border-gray-300 px-1.5 py-1"
      >
        <option value="">— column —</option>
        {columns.map((c) => <option key={c} value={c}>{c}</option>)}
      </select>
      <select name={`f${n}o`} value={op} onChange={(e) => setOp(e.target.value)} className="rounded border border-gray-300 px-1.5 py-1">
        {OPS.map((o) => <option key={o.op} value={o.op}>{o.label}</option>)}
      </select>
      {useList ? (
        <select
          name={`f${n}v`}
          value={value}
          onChange={(e) => {
            if (e.target.value === OTHER) {
              setCustom(true);
              setValue("");
            } else setValue(e.target.value);
          }}
          className="max-w-xs rounded border border-gray-300 px-1.5 py-1"
          aria-label="value"
        >
          <option value="">— any value —</option>
          {values!.map((v) => <option key={v} value={v}>{v === "" ? "(empty)" : v}</option>)}
          <option value={OTHER}>Other…</option>
        </select>
      ) : (
        <input
          name={`f${n}v`}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          inputMode={numeric ? "decimal" : undefined}
          placeholder={loading ? "loading values…" : numeric ? "number" : "value"}
          className="w-48 rounded border border-gray-300 px-1.5 py-1"
          aria-label="value"
        />
      )}
      {custom && !numeric && values && values.length > 0 && (
        <button type="button" onClick={() => { setCustom(false); setValue(""); }} className="text-brand-700 hover:underline">
          pick from list
        </button>
      )}
    </div>
  );
}
