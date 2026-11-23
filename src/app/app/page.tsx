import { getAppContext } from "@/server/appContext";
import { getUser } from "@/server/supabase/server";
import { dataSpaceStatus, loadConnections, modeBadge, PROVIDER_LABEL } from "@/server/companyStatus";
import { loadAnalytics } from "@/server/analyticsLoader";
import { OverviewCards } from "@/components/AnalyticsView";
import { AutoRefresh } from "@/components/AutoRefresh";
import { Badge, Card, LinkButton, Notice, SimulatedBanner } from "@/components/ui";
import { fmtDateTime } from "@/lib/format";
import { profileFor } from "@/lib/businessTypes";

function Step({ done, n, title, children }: { done: boolean; n: number; title: string; children: React.ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className={`flex h-7 w-7 flex-none items-center justify-center rounded-full text-sm font-semibold ${done ? "bg-green-600 text-white" : "bg-gray-200 text-gray-700"}`}>{done ? "✓" : n}</span>
      <div><p className="font-medium text-gray-900">{title}</p><div className="text-sm text-gray-600">{children}</div></div>
    </li>
  );
}

export default async function Dashboard({ searchParams }: { searchParams: Promise<{ password?: string }> }) {
  const sp = await searchParams;
  const ctx = await getAppContext();
  const { supabase } = await getUser();
  const company = ctx.company;
  const space = company ? (await dataSpaceStatus(supabase, [company.id]))[company.id]! : null;
  const conns = company ? await loadConnections(supabase, company.id) : null;
  const analytics = company && space?.status === "ready" ? await loadAnalytics(ctx.userId, company, {}) : null;
  const hasData = (analytics?.data.current?.rowCount ?? 0) > 0;
  const hasAnyImport = (conns?.runs ?? []).some((r) => r.status === "succeeded");

  return (
    <div className="space-y-6">
      {sp.password && <Notice tone="green">Your password was updated.</Notice>}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">{company ? company.name : "Welcome"}</h1>
          {company && <p className="text-sm text-gray-600">{profileFor(company.business_type).label}{analytics ? ` · last 28 complete days · ${analytics.range.from} → ${analytics.range.to} · ${company.timezone}` : ""}</p>}
        </div>
        {hasData && <LinkButton href="/app/analytics" variant="secondary">Open full analytics</LinkButton>}
      </div>
      <AutoRefresh active={space?.status === "pending" || space?.status === "preparing" || (conns?.runs ?? []).some((r) => r.status === "queued" || r.status === "running")} />

      {!hasData && (
        <Card title="Get started">
          <ol className="space-y-4">
            <Step n={1} done title="Create your account">You are signed in.</Step>
            <Step n={2} done={!!company} title="Add a company">{company ? `${ctx.companies.length} compan${ctx.companies.length === 1 ? "y" : "ies"} added.` : <a className="text-brand-700" href="/app/companies">Add your first company →</a>}</Step>
            <Step n={3} done={space?.status === "ready"} title="Data space prepared">
              {space ? (space.status === "ready" ? (space.simulated ? "Ready (local simulated warehouse — BigQuery is not configured in this environment)." : "Ready in BigQuery.") : `Status: ${space.status}.`) : "Happens automatically after you add a company."}
            </Step>
            <Step n={4} done={hasAnyImport} title="Connect a source or upload a CSV"><a className="text-brand-700" href="/app/connections">Go to Data Connections →</a></Step>
            <Step n={5} done={hasData} title="See your KPIs">Your numbers appear here after the first import.</Step>
          </ol>
        </Card>
      )}

      {analytics?.data.current && hasData && (
        <>
          {analytics.data.current.hasSimulated && <SimulatedBanner what="This company has a sample-data connection." />}
          <OverviewCards current={analytics.data.current} previous={analytics.data.previous} />
        </>
      )}

      {company && (
        <Card title={`What to watch for a ${profileFor(company.business_type).label.toLowerCase()}`}>
          <ul className="list-disc pl-5 text-sm text-gray-700">{profileFor(company.business_type).focus.map((f) => <li key={f}>{f}</li>)}</ul>
          <p className="mt-2 text-xs text-gray-500">Some of these need sources that are not connected yet. <a className="text-brand-700" href="/app/connections">See recommended sources</a>.</p>
        </Card>
      )}

      {conns && conns.connections.length > 0 && (
        <Card title="Data freshness">
          <ul className="divide-y divide-gray-100 text-sm">
            {conns.connections.map((c) => {
              const b = modeBadge(c.mode);
              return (
                <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <span className="font-medium">{PROVIDER_LABEL[c.provider_id] ?? c.provider_id} <Badge tone={b.tone}>{b.text}</Badge></span>
                  <span className="text-gray-600">Updated {fmtDateTime(c.last_synced_at)} · data up to {c.data_as_of ?? "—"} {c.status !== "connected" && <Badge tone="red">{c.status}</Badge>}</span>
                </li>
              );
            })}
          </ul>
          {conns.issues.filter((i) => i.severity !== "info").length > 0 && (
            <p className="mt-3 text-sm text-amber-800">There are data-quality warnings. <a className="underline" href="/app/connections">Review them</a>.</p>
          )}
          {conns.runs.some((r) => r.status === "failed" || r.status === "dead") && (
            <p className="mt-2 text-sm text-red-700">An update failed. <a className="underline" href="/app/connections">See details</a>.</p>
          )}
        </Card>
      )}
    </div>
  );
}
