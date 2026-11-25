import { getCompanyContext } from "@/server/appContext";
import { getUser } from "@/server/supabase/server";
import { dataSpaceStatus, loadConnections, modeBadge, PROVIDER_LABEL, type SyncRunRow } from "@/server/companyStatus";
import { AutoRefresh } from "@/components/AutoRefresh";
import { Badge, Button, Card, EmptyState, LinkButton, Notice } from "@/components/ui";
import { fmtDateTime } from "@/lib/format";
import { LoadStatus } from "@/components/LoadStatus";
import { getPool } from "@/server/db";
import { queuePositions } from "@/server/jobs/queue";
import { syncNowAction } from "../actions";


export default async function ConnectionsPage({ searchParams }: { searchParams: Promise<{ error?: string; imported?: string; sample?: string; queued?: string; oauth?: string; connected?: string; deleted?: string }> }) {
  const sp = await searchParams;
  const ctx = await getCompanyContext();
  const { supabase } = await getUser();
  const company = ctx.company;
  const space = (await dataSpaceStatus(supabase, [company.id]))[company.id]!;
  const { connections, runs, issues } = await loadConnections(supabase, company.id);
  const running = runs.some((r) => r.status === "queued" || r.status === "running");
  const lastRun = new Map<string, SyncRunRow>();
  for (const r of runs) if (!lastRun.has(r.connection_id) && r.status !== "cancelled") lastRun.set(r.connection_id, r);
  const positions = await queuePositions(getPool(), [...lastRun.values()].filter((r) => r.status === "queued").map((r) => r.id));

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Data Connections</h1>
          <p className="text-sm text-gray-600">Connected sources update automatically every night ({company.timezone}).</p>
        </div>
        <LinkButton href="/app/connections/new">+ Add connector</LinkButton>
      </div>
      {sp.error && <Notice tone="red">{sp.error}</Notice>}
      {sp.oauth && <Notice tone="amber">{sp.oauth}</Notice>}
      {sp.imported && <Notice tone="green">Import started. Your data will appear in the dashboard in a moment.</Notice>}
      {sp.sample && <Notice tone="green">Sample data connection added.</Notice>}
      {sp.queued && <Notice tone="green">Update requested.</Notice>}
      {sp.deleted && <Notice tone="green">Connector deleted: {sp.deleted}. Its data was removed from the dashboard.</Notice>}
      {sp.connected && <Notice tone="green">Connected: {sp.connected}. The first import is running — numbers appear on the dashboard in a minute or two.</Notice>}
      {space.status !== "ready" && <Notice tone="blue">This company&apos;s data space is still being prepared ({space.status}). You can add data once it is ready.</Notice>}
      <AutoRefresh active={running || space.status === "pending" || space.status === "preparing"} />

      {connections.length === 0 ? (
        <EmptyState title="No connectors yet">
          Connect a source or upload a CSV to start collecting this company&apos;s data.
          <div className="mt-4"><LinkButton href="/app/connections/new">+ Add connector</LinkButton></div>
        </EmptyState>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {connections.map((c) => {
            const b = modeBadge(c.mode);
            const r = lastRun.get(c.id);
            return (
              <li key={c.id} className="flex flex-col rounded-xl border border-gray-200 bg-white p-4" data-testid="connection-row">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <a href={`/app/connections/${c.id}`} className="text-lg font-semibold text-gray-900 hover:text-brand-700 hover:underline">{PROVIDER_LABEL[c.provider_id] ?? c.provider_id}</a>
                    {c.external_account_name && <p className="text-xs text-gray-500">{c.external_account_name}</p>}
                  </div>
                  <Badge tone={b.tone}>{b.text}</Badge>
                </div>
                <dl className="mt-3 space-y-1 text-sm">
                  <div className="flex justify-between gap-2"><dt className="text-gray-500">Status</dt><dd><Badge tone={c.status === "connected" ? "green" : c.status === "expired" || c.status === "error" ? "red" : "gray"}>{c.status === "expired" ? "Needs reconnecting" : c.status}</Badge></dd></div>
                  <div className="flex justify-between gap-2"><dt className="text-gray-500">Last update</dt><dd className="text-gray-900">{fmtDateTime(c.last_synced_at, company.timezone)}</dd></div>
                  <div className="flex justify-between gap-2"><dt className="text-gray-500">Data up to</dt><dd className="text-gray-900">{c.data_as_of ?? "—"}</dd></div>
                  <div className="flex justify-between gap-2"><dt className="text-gray-500">Loading</dt><dd>{c.mode !== "manual" && !c.activated_at ? <a href={`/app/connections/${c.id}#setup`}><Badge tone="amber">Needs setup</Badge></a> : <LoadStatus run={r} position={r ? positions.get(r.id) : undefined} tz={company.timezone} />}</dd></div>
                </dl>
                {c.last_error && <p className="mt-2 text-xs text-red-700">{c.last_error}</p>}
                <div className="mt-auto flex flex-wrap gap-2 pt-4">
                  {c.mode !== "manual" && !c.activated_at ? <LinkButton href={`/app/connections/${c.id}#setup`}>Finish setup</LinkButton> : <LinkButton href={`/app/connections/${c.id}`} variant="secondary">Open</LinkButton>}
                  {c.mode === "manual" && <LinkButton href="/app/connections/csv" variant="secondary">Upload new file</LinkButton>}
                  {c.mode !== "manual" && c.activated_at && (
                    <form action={syncNowAction}>
                      <input type="hidden" name="connection_id" value={c.id} />
                      <Button variant="secondary">Update now</Button>
                    </form>
                  )}
                </div>
              </li>
            );
          })}
          <li>
            <a href="/app/connections/new" className="flex h-full min-h-40 items-center justify-center rounded-xl border border-dashed border-gray-300 bg-white p-4 text-sm font-medium text-brand-700 hover:border-brand-300 hover:bg-brand-50">+ Add connector</a>
          </li>
        </ul>
      )}

      {connections.length > 0 && (
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Recent updates">
          {runs.length === 0 ? <p className="text-sm text-gray-600">No updates yet.</p> : (
            <ul className="divide-y divide-gray-100 text-sm">
              {runs.map((r) => (
                <li key={r.id} className="py-2" data-testid="sync-run">
                  <div className="flex items-center justify-between gap-2">
                    <span>{PROVIDER_LABEL[r.provider_id] ?? r.provider_id} · {r.trigger.replace("_", " ")}{r.is_simulated ? " · sample data" : ""}</span>
                    <Badge tone={r.status === "succeeded" ? "green" : r.status === "failed" || r.status === "dead" ? "red" : r.status === "cancelled" ? "gray" : "blue"}>{r.status}</Badge>
                  </div>
                  <div className="text-xs text-gray-500">
                    {fmtDateTime(r.created_at, company.timezone)}{r.window_start ? ` · days ${r.window_start} → ${r.window_end}` : ""} · {r.rows_written} rows{r.attempts > 1 ? ` · attempt ${r.attempts}` : ""}
                  </div>
                  {r.error_code && r.status !== "succeeded" && <div className="text-xs text-red-700">{r.status === "queued" ? "Will retry automatically: " : ""}{r.error_code}</div>}
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title="Data checks">
          {issues.length === 0 ? <p className="text-sm text-gray-600">No open data-quality notes.</p> : (
            <ul className="divide-y divide-gray-100 text-sm">
              {issues.map((i) => (
                <li key={i.id} className="py-2">
                  <Badge tone={i.severity === "error" ? "red" : i.severity === "warning" ? "amber" : "gray"}>{i.severity}</Badge>{" "}
                  {i.message}{i.metric_date ? ` (${i.metric_date})` : ""}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      )}
    </div>
  );
}
