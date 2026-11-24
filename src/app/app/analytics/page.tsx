import { getCompanyContext } from "@/server/appContext";
import { loadAnalytics } from "@/server/analyticsLoader";
import { AnalyticsView } from "@/components/AnalyticsView";
import { EmptyState, Notice } from "@/components/ui";

const PRESETS = [7, 28, 90, 365];

export default async function AnalyticsPage({ searchParams }: { searchParams: Promise<{ from?: string; to?: string; days?: string }> }) {
  const sp = await searchParams;
  const ctx = await getCompanyContext();
  if (!ctx.company) return <EmptyState title="No company selected">Add a company to see analytics. <a className="text-brand-700" href="/app/companies">Add a company</a>.</EmptyState>;
  const { range, data } = await loadAnalytics(ctx.userId, ctx.company, sp);
  const exportHref = `/api/export?company=${ctx.company.id}&from=${range.from}&to=${range.to}`;
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Analytics — {ctx.company.name}</h1>
          <p className="text-sm text-gray-600">{range.from} → {range.to} ({ctx.company.timezone}), compared with the previous period of the same length.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {PRESETS.map((d) => (
            <a key={d} href={`/app/analytics?days=${d}`} className={`rounded-lg px-3 py-1.5 text-sm ring-1 ring-gray-300 ${!sp.from && Number(sp.days ?? 28) === d ? "bg-brand-50 text-brand-700" : "bg-white"}`}>Last {d} days</a>
          ))}
          <form className="flex items-center gap-1 text-sm" action="/app/analytics">
            <input aria-label="From" type="date" name="from" defaultValue={range.from} className="rounded border border-gray-300 px-2 py-1" />
            <input aria-label="To" type="date" name="to" defaultValue={range.to} className="rounded border border-gray-300 px-2 py-1" />
            <button className="rounded-lg bg-white px-3 py-1.5 ring-1 ring-gray-300">Apply</button>
          </form>
          {data.status === "ready" && <a href={exportHref} className="rounded-lg bg-brand-600 px-3 py-1.5 text-sm font-medium text-white">Export CSV</a>}
        </div>
      </div>
      {data.isSimulatedWarehouse && data.status === "ready" && (
        <p className="text-xs text-gray-500">Storage: local simulated warehouse (development mode, not BigQuery). Uploaded numbers are your real data; only the storage is simulated.</p>
      )}
      {data.status !== "ready" && <Notice tone="blue">This company's data space is {data.status === "no_dataset" ? "not created yet" : data.status}. Analytics will be available once it is ready.</Notice>}
      {data.status === "ready" && data.current && data.current.rowCount === 0 && (
        <EmptyState title="No data in this period">Connect a source or <a className="text-brand-700" href="/app/connections/csv">upload a CSV</a>, or choose another date range.</EmptyState>
      )}
      {data.status === "ready" && data.current && data.current.rowCount > 0 && <AnalyticsView current={data.current} previous={data.previous} campaigns={data.campaigns} />}
    </div>
  );
}
