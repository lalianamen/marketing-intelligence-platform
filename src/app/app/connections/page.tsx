import { getAppContext } from "@/server/appContext";
import { getUser } from "@/server/supabase/server";
import { dataSpaceStatus, loadConnections, modeBadge, PROVIDER_LABEL } from "@/server/companyStatus";
import { googleOAuthConfigured, loadConfig } from "@/server/config";
import { AutoRefresh } from "@/components/AutoRefresh";
import { Badge, Button, Card, EmptyState, LinkButton, Notice } from "@/components/ui";
import { fmtDateTime } from "@/lib/format";
import { disconnectAction, enableSampleConnectionAction, syncNowAction } from "../actions";

export default async function ConnectionsPage({ searchParams }: { searchParams: Promise<{ error?: string; imported?: string; sample?: string; queued?: string; oauth?: string }> }) {
  const sp = await searchParams;
  const ctx = await getAppContext();
  const { supabase } = await getUser();
  if (!ctx.company) {
    return <EmptyState title="Add a company first">Data connections belong to a company. <a className="text-brand-700" href="/app/companies">Add a company</a>.</EmptyState>;
  }
  const company = ctx.company;
  const space = (await dataSpaceStatus(supabase, [company.id]))[company.id]!;
  const { connections, runs, issues } = await loadConnections(supabase, company.id);
  const { data: providers } = await supabase.from("connector_providers").select("id,display_name,availability,description").order("display_name");
  const oauthReady = googleOAuthConfigured(loadConfig());
  const running = runs.some((r) => r.status === "queued" || r.status === "running");
  const live = (p: string) => connections.find((c) => c.provider_id === p && c.mode === "live");
  const sample = (p: string) => connections.find((c) => c.provider_id === p && c.mode === "simulated");

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Data Connections</h1>
        <p className="text-sm text-gray-600">For <strong>{company.name}</strong>. Data is updated automatically every night ({company.timezone}).</p>
      </div>
      {sp.error && <Notice tone="red">{sp.error}</Notice>}
      {sp.oauth && <Notice tone="amber">{sp.oauth}</Notice>}
      {sp.imported && <Notice tone="green">Import started. Your data will appear in Analytics in a moment.</Notice>}
      {sp.queued && <Notice tone="green">Update requested.</Notice>}
      {space.status !== "ready" && <Notice tone="blue">This company's data space is still being prepared ({space.status}). You can add data once it is ready.</Notice>}
      <AutoRefresh active={running || space.status === "pending" || space.status === "preparing"} />

      <div className="grid gap-4 md:grid-cols-3">
        <Card title="Upload a spreadsheet (CSV)" actions={<Badge tone="green">Available</Badge>}>
          <p className="text-sm text-gray-600">Works for any platform (Meta, Microsoft Ads, Yelp reports, your CRM…). Use our template so numbers are read correctly.</p>
          <div className="mt-4 flex flex-wrap gap-2">
            <LinkButton href="/app/connections/csv">Upload CSV</LinkButton>
            <LinkButton href="/sample-marketing-data.csv" variant="secondary">Download template</LinkButton>
          </div>
        </Card>
        {(["ga4", "google_ads"] as const).map((p) => (
          <Card key={p} title={PROVIDER_LABEL[p]} actions={live(p) ? <Badge tone="green">Connected</Badge> : <Badge tone="gray">Not connected</Badge>}>
            <p className="text-sm text-gray-600">
              {p === "ga4" ? "Daily website report numbers: sessions, key events and GA4-reported revenue." : "Daily campaign numbers: cost, impressions, clicks and Google Ads conversions."}
            </p>
            <div className="mt-4 space-y-2">
              {oauthReady ? (
                <form action="/api/oauth/google/start" method="get">
                  <input type="hidden" name="provider" value={p} />
                  <input type="hidden" name="company" value={company.id} />
                  <label className="mb-2 block text-xs text-gray-600">
                    {p === "ga4" ? "GA4 property ID (Admin → Property details)" : "Google Ads customer ID (top right in Google Ads, 123-456-7890)"}
                    <input name="account" required pattern={p === "ga4" ? "[0-9]{1,20}" : "[0-9]{3}-?[0-9]{3}-?[0-9]{4}"} className="mt-1 block w-full rounded border border-gray-300 px-2 py-1 text-sm" />
                  </label>
                  <Button disabled={space.status !== "ready"}>Connect with Google</Button>
                </form>
              ) : (
                <p className="text-xs text-gray-500">
                  Live connection is not set up yet: an administrator must configure Google sign-in for this app first (see docs/CONNECTORS.md).
                </p>
              )}
              {!sample(p) && (
                <form action={enableSampleConnectionAction}>
                  <input type="hidden" name="company_id" value={company.id} />
                  <input type="hidden" name="provider_id" value={p} />
                  <Button variant="secondary" disabled={space.status !== "ready"}>Try with sample data</Button>
                </form>
              )}
            </div>
          </Card>
        ))}
      </div>

      <Card title="Your connections">
        {connections.length === 0 ? (
          <p className="text-sm text-gray-600">Nothing connected yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-xs uppercase text-gray-500">
                <tr><th className="py-2">Source</th><th>Type</th><th>Status</th><th>Last updated</th><th>Data up to</th><th></th></tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {connections.map((c) => {
                  const b = modeBadge(c.mode);
                  return (
                    <tr key={c.id} data-testid="connection-row">
                      <td className="py-2 font-medium">{PROVIDER_LABEL[c.provider_id] ?? c.provider_id}<div className="text-xs text-gray-500">{c.external_account_name}</div></td>
                      <td><Badge tone={b.tone}>{b.text}</Badge></td>
                      <td>
                        <Badge tone={c.status === "connected" ? "green" : c.status === "expired" || c.status === "error" ? "red" : "gray"}>{c.status === "expired" ? "Needs reconnecting" : c.status}</Badge>
                        {c.last_error && <div className="mt-1 max-w-xs text-xs text-red-700">{c.last_error}</div>}
                      </td>
                      <td>{fmtDateTime(c.last_synced_at)}</td>
                      <td>{c.data_as_of ?? "—"}</td>
                      <td className="space-x-2 whitespace-nowrap text-right">
                        {c.mode !== "manual" && (
                          <form action={syncNowAction} className="inline">
                            <input type="hidden" name="connection_id" value={c.id} />
                            <Button variant="secondary">Update now</Button>
                          </form>
                        )}
                        {c.mode !== "manual" && (
                          <form action={disconnectAction} className="inline">
                            <input type="hidden" name="connection_id" value={c.id} />
                            <Button variant="danger">Disconnect</Button>
                          </form>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

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
                    {fmtDateTime(r.created_at)}{r.window_start ? ` · days ${r.window_start} → ${r.window_end}` : ""} · {r.rows_written} rows{r.attempts > 1 ? ` · attempt ${r.attempts}` : ""}
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

      <Card title="Other platforms">
        <p className="mb-3 text-sm text-gray-600">Direct connections for these platforms are not available yet. Upload their reports as CSV meanwhile.</p>
        <ul className="grid gap-2 text-sm sm:grid-cols-2 lg:grid-cols-3">
          {(providers ?? []).filter((p) => !["csv", "ga4", "google_ads"].includes(p.id)).map((p) => (
            <li key={p.id} className="rounded-lg border border-gray-200 p-3">
              <div className="flex items-center justify-between"><span className="font-medium">{p.display_name}</span>
                <Badge tone={p.availability === "requires_partner_access" ? "red" : "gray"}>{p.availability === "requires_partner_access" ? "Requires partner access" : "Planned"}</Badge></div>
              <p className="mt-1 text-xs text-gray-500">{p.description}</p>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
