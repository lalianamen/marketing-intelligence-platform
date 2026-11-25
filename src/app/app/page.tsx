import { getCompanyContext } from "@/server/appContext";
import { getUser } from "@/server/supabase/server";
import { dataSpaceStatus, loadConnections, modeBadge, PROVIDER_LABEL, type ConnectionRow, type SyncRunRow } from "@/server/companyStatus";
import { loadAnalytics } from "@/server/analyticsLoader";
import { OverviewCards, sourceLabel } from "@/components/AnalyticsView";
import { BarList, LineChart } from "@/components/Charts";
import { AutoRefresh } from "@/components/AutoRefresh";
import { Badge, EmptyState, LinkButton, Notice, SimulatedBanner } from "@/components/ui";
import { fmtDateTime, fmtInt, fmtMoney } from "@/lib/format";
import { LoadStatus } from "@/components/LoadStatus";
import { getPool } from "@/server/db";
import { queuePositions } from "@/server/jobs/queue";

const PRESETS = [7, 28, 90];

function ago(iso: string | null): string {
  if (!iso) return "never";
  const min = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
}


function ConnectorCard({ c, lastRun, tz, position }: { c: ConnectionRow; lastRun: SyncRunRow | undefined; tz: string; position?: number }) {
  const b = modeBadge(c.mode);
  return (
    <li className="relative rounded-xl border border-gray-200 bg-white p-4 transition hover:border-brand-300 hover:shadow-sm" data-testid="connector-card">
      <a href={`/app/connections/${c.id}`} className="absolute inset-0 rounded-xl" aria-label={`Open ${PROVIDER_LABEL[c.provider_id] ?? c.provider_id}`} />
      <div className="flex items-start justify-between gap-2">
        <p className="font-medium text-gray-900">{PROVIDER_LABEL[c.provider_id] ?? c.provider_id}</p>
        <Badge tone={b.tone}>{b.text}</Badge>
      </div>
      {c.external_account_name && <p className="text-xs text-gray-500">{c.external_account_name}</p>}
      <dl className="mt-3 space-y-1 text-sm">
        <div className="flex justify-between gap-2"><dt className="text-gray-500">Last update</dt><dd className="text-right font-medium text-gray-900" title={fmtDateTime(c.last_synced_at, tz)}>{ago(c.last_synced_at)}</dd></div>
        <div className="flex justify-between gap-2"><dt className="text-gray-500">Data up to</dt><dd className="text-right text-gray-900">{c.data_as_of ?? "—"}</dd></div>
        <div className="flex justify-between gap-2">
          <dt className="text-gray-500">Loading</dt>
          <dd>{c.mode !== "manual" && !c.activated_at ? <Badge tone="amber">Needs setup</Badge> : <LoadStatus run={lastRun} position={position} tz={tz} />}</dd>
        </div>
      </dl>
      {c.status !== "connected" && <p className="mt-2 text-xs text-red-700">{c.last_error ?? `Status: ${c.status}`}</p>}
    </li>
  );
}

export default async function Dashboard({ searchParams }: { searchParams: Promise<{ password?: string; days?: string }> }) {
  const sp = await searchParams;
  const ctx = await getCompanyContext();
  const { supabase } = await getUser();
  const company = ctx.company;
  const days = PRESETS.includes(Number(sp.days)) ? Number(sp.days) : 28;
  const space = (await dataSpaceStatus(supabase, [company.id]))[company.id]!;
  const conns = await loadConnections(supabase, company.id);
  const analytics = space.status === "ready" ? await loadAnalytics(ctx.userId, company, { days: String(days) }) : null;
  const current = analytics?.data.current ?? null;
  const previous = analytics?.data.previous ?? null;
  const hasData = (current?.rowCount ?? 0) > 0;
  const busy = space.status === "pending" || space.status === "preparing" || conns.runs.some((r) => r.status === "queued" || r.status === "running");
  const lastRunByConn = new Map<string, SyncRunRow>();
  for (const r of conns.runs) if (!lastRunByConn.has(r.connection_id) && r.status !== "cancelled") lastRunByConn.set(r.connection_id, r);
  const positions = await queuePositions(getPool(), [...lastRunByConn.values()].filter((r) => r.status === "queued").map((r) => r.id));
  const single = current && current.currencies.length === 1 ? current.currencies[0]! : null;
  const money = (m: Record<string, number>) => Object.values(m).reduce((a, b) => a + b, 0);
  const has = (k: "sessions" | "clicks" | "spend") => (current?.daily ?? []).some((d) => d[k] !== null && d[k] !== 0);
  const desc = <T extends { value: number }>(xs: T[]) => [...xs].sort((a, b) => b.value - a.value);

  return (
    <div className="space-y-6">
      {sp.password && <Notice tone="green">Your password was updated.</Notice>}
      <AutoRefresh active={busy} />
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Dashboard</h1>
          {analytics && <p className="text-sm text-gray-600">Last {days} complete days · {analytics.range.from} → {analytics.range.to} · {company.timezone} · compared with the previous {days} days</p>}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {PRESETS.map((d) => (
            <a key={d} href={`/app?days=${d}`} className={`rounded-lg px-3 py-1.5 text-sm ring-1 ring-gray-300 ${d === days ? "bg-brand-50 text-brand-700" : "bg-white text-gray-700"}`}>{d} days</a>
          ))}
          <LinkButton href={`/app/analytics?days=${days}`} variant="secondary">Full analytics</LinkButton>
        </div>
      </div>

      <section>
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-base font-semibold">Connectors</h2>
          <a href="/app/connections" className="text-sm text-brand-700 hover:underline">Manage connections →</a>
        </div>
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {conns.connections.map((c) => <ConnectorCard key={c.id} c={c} lastRun={lastRunByConn.get(c.id)} position={positions.get(lastRunByConn.get(c.id)?.id ?? "")} tz={company.timezone} />)}
          <li>
            <a href="/app/connections" className="flex h-full min-h-32 items-center justify-center rounded-xl border border-dashed border-gray-300 bg-white p-4 text-sm font-medium text-brand-700 hover:border-brand-300 hover:bg-brand-50">
              + Connect a source or upload CSV
            </a>
          </li>
        </ul>
        {conns.runs.some((r) => r.status === "failed" || r.status === "dead") && (
          <p className="mt-2 text-sm text-red-700">An update failed. <a className="underline" href="/app/connections">See details</a>.</p>
        )}
        {conns.issues.some((i) => i.severity !== "info") && (
          <p className="mt-2 text-sm text-amber-800">There are data-quality warnings. <a className="underline" href="/app/connections">Review them</a>.</p>
        )}
      </section>

      {conns.connections.some((c) => c.mode !== "manual" && !c.activated_at) && (
        <Notice tone="amber">
          Finish setting up {conns.connections.filter((c) => c.mode !== "manual" && !c.activated_at).map((c) => PROVIDER_LABEL[c.provider_id] ?? c.provider_id).join(", ")}: choose the data, period and schedule, then start loading.{" "}
          <a className="underline" href={`/app/connections/${conns.connections.find((c) => c.mode !== "manual" && !c.activated_at)!.id}#setup`}>Open setup</a>
        </Notice>
      )}
      {space.status !== "ready" && <Notice tone="blue">The company&apos;s data space is being prepared. Charts appear once it is ready and data is imported.</Notice>}

      {space.status === "ready" && !hasData && (
        <EmptyState title="No data in this period">
          Upload a CSV or connect a source, or choose a longer period above.
        </EmptyState>
      )}

      {current && hasData && (
        <>
          {current.hasSimulated && <SimulatedBanner what="This company has a sample-data connection." />}
          <OverviewCards current={current} previous={previous} />
          <div className="grid gap-4 lg:grid-cols-2">
            {has("sessions") && <LineChart title="Website sessions per day" points={current.daily.map((d) => ({ x: d.date, y: d.sessions }))} format={(n) => fmtInt(n)} />}
            {has("clicks") && <LineChart title="Clicks per day" points={current.daily.map((d) => ({ x: d.date, y: d.clicks }))} format={(n) => fmtInt(n)} />}
            {single && has("spend") && <LineChart title={`Ad spend per day (${single})`} points={current.daily.map((d) => ({ x: d.date, y: d.spend }))} format={(n) => fmtMoney(n, single)} />}
            <BarList
              title="Sessions by source"
              items={desc(current.bySource.filter((s) => (s.totals.sessions ?? 0) > 0).map((s) => ({ label: sourceLabel(s.origin, s.source), value: s.totals.sessions!, note: s.isSimulated ? "simulated" : undefined })))}
              format={(n) => fmtInt(n)}
            />
            <BarList
              title="Leads / sign-ups by source"
              items={desc(current.bySource.filter((s) => (s.totals.leads ?? 0) > 0).map((s) => ({ label: sourceLabel(s.origin, s.source), value: s.totals.leads!, note: s.isSimulated ? "simulated" : undefined })))}
              format={(n) => fmtInt(n)}
            />
            {single && (
              <BarList
                title={`Revenue by source (${single})`}
                items={current.bySource
                  .map((s) => ({ s, v: money(s.totals.billedRevenueByCurrency) + money(s.totals.attributedRevenueByCurrency) }))
                  .filter((x) => x.v > 0)
                  .map(({ s, v }) => ({ label: sourceLabel(s.origin, s.source), value: v, note: s.isSimulated ? "simulated" : undefined }))}
                format={(n) => fmtMoney(n, single)}
              />
            )}
            {single && (
              <BarList
                title={`Spend by source (${single})`}
                items={current.bySource.filter((s) => s.totals.spendByCurrency[single]).map((s) => ({ label: sourceLabel(s.origin, s.source), value: s.totals.spendByCurrency[single]!, note: s.isSimulated ? "simulated" : undefined }))}
                format={(n) => fmtMoney(n, single)}
              />
            )}
          </div>
        </>
      )}
    </div>
  );
}
