import { fmtDelta } from "@/lib/format";

export function KpiCard({ label, value, delta, hint, testId }: { label: string; value: string; delta?: number | null; hint?: string; testId?: string }) {
  const d = delta === undefined ? null : fmtDelta(delta);
  const tone = d?.tone === "up" ? "text-green-700" : d?.tone === "down" ? "text-red-700" : "text-gray-500";
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4" data-testid={testId}>
      <p className="text-xs font-medium uppercase tracking-wide text-gray-500">{label}</p>
      <p className={`mt-1 text-2xl font-semibold ${value === "Not available" ? "text-base text-gray-400" : "text-gray-900"}`}>{value}</p>
      {d && <p className={`mt-1 text-xs ${tone}`}>{d.text} vs previous period</p>}
      {hint && <p className="mt-1 text-xs text-gray-500">{hint}</p>}
    </div>
  );
}
