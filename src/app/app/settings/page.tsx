import { getAppContext } from "@/server/appContext";
import { getUser } from "@/server/supabase/server";
import { googleOAuthConfigured, loadConfig } from "@/server/config";
import { Badge, Button, Card, Field, Notice } from "@/components/ui";
import { renameWorkspaceAction, updateCompanyAction } from "../actions";
import { BUSINESS_PROFILES, BUSINESS_TYPES } from "@/lib/businessTypes";

export default async function SettingsPage({ searchParams }: { searchParams: Promise<{ saved?: string }> }) {
  const sp = await searchParams;
  const ctx = await getAppContext();
  const { supabase } = await getUser();
  const cfg = loadConfig();
  const isAdmin = ["owner", "admin"].includes(ctx.workspace.role);
  const [{ data: resources }, { data: jobs }, { data: usage }, { data: audit }] = await Promise.all([
    supabase.from("analytics_resources").select("company_id,provider,project_id,dataset_id,location,status,schema_version,is_simulated,verified_at"),
    supabase.from("provisioning_jobs").select("company_id,status,attempts,last_error_code,created_at").order("created_at", { ascending: false }).limit(20),
    isAdmin ? supabase.from("usage_events").select("kind,quantity,unit,bytes_processed,bytes_billed,estimated_cost_usd").eq("workspace_id", ctx.workspace.id).limit(1000) : Promise.resolve({ data: [] }),
    isAdmin ? supabase.from("audit_logs").select("action,target_type,created_at,actor_type").eq("workspace_id", ctx.workspace.id).order("created_at", { ascending: false }).limit(20) : Promise.resolve({ data: [] }),
  ]);
  const usageByKind = new Map<string, { n: number; q: number; unit: string; bytes: number; cost: number }>();
  for (const u of usage ?? []) {
    const e = usageByKind.get(u.kind) ?? { n: 0, q: 0, unit: u.unit, bytes: 0, cost: 0 };
    e.n++;
    e.q += Number(u.quantity);
    e.bytes += Number(u.bytes_billed ?? 0);
    e.cost += Number(u.estimated_cost_usd ?? 0);
    usageByKind.set(u.kind, e);
  }
  const name = (id: string) => ctx.companies.find((c) => c.id === id)?.name ?? id;

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Settings</h1>
      {sp.saved && <Notice tone="green">Saved.</Notice>}
      <div className="grid gap-4 md:grid-cols-2">
        <Card title="Your account">
          <p className="text-sm text-gray-700">{ctx.email}</p>
          <p className="mt-1 text-xs text-gray-500">Role in this workspace: {ctx.workspace.role}</p>
          <a className="mt-3 inline-block text-sm text-brand-700" href="/forgot-password">Change password</a>
        </Card>
        <Card title="Workspace">
          {isAdmin ? (
            <form action={renameWorkspaceAction} className="space-y-3">
              <input type="hidden" name="workspace_id" value={ctx.workspace.id} />
              <Field label="Workspace name" name="name" required defaultValue={ctx.workspace.name} />
              <Button variant="secondary">Save</Button>
            </form>
          ) : <p className="text-sm">{ctx.workspace.name}</p>}
          <p className="mt-3 text-xs text-gray-500">Inviting team members and client viewers is planned for a later phase.</p>
        </Card>
        {ctx.company && (
          <Card title="Selected company">
            <form action={updateCompanyAction} className="space-y-3">
              <input type="hidden" name="company_id" value={ctx.company.id} />
              <Field label="Company name" name="name" required defaultValue={ctx.company.name} />
              <label className="block">
                <span className="text-sm font-medium text-gray-800">Business type</span>
                <select name="business_type" defaultValue={ctx.company.business_type} className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm">
                  {BUSINESS_TYPES.map((t) => <option key={t} value={t}>{BUSINESS_PROFILES[t].label}</option>)}
                </select>
                <span className="mt-1 block text-xs text-gray-500">Changing it never deletes data; it only changes suggestions.</span>
              </label>
              <p className="text-xs text-gray-500">Time zone: {ctx.company.timezone}. Nightly updates run at 06:00 local time plus a short buffer per source.</p>
              <Button variant="secondary">Save</Button>
            </form>
          </Card>
        )}
      </div>

      <details className="rounded-xl border border-gray-200 bg-white p-5" data-testid="advanced">
        <summary className="cursor-pointer text-base font-semibold">Advanced (administrator / developer)</summary>
        <div className="mt-4 space-y-6 text-sm">
          <div className="flex flex-wrap gap-2">
            <Badge tone={cfg.warehouseMode === "bigquery" ? "green" : "amber"}>Warehouse: {cfg.warehouseMode === "bigquery" ? "BigQuery (real)" : "local simulated (not BigQuery)"}</Badge>
            {cfg.warehouseMode === "bigquery" && <Badge tone={cfg.bigquery.billingApproved ? "green" : "red"}>Billing approved: {String(cfg.bigquery.billingApproved)}</Badge>}
            <Badge tone={googleOAuthConfigured(cfg) ? "green" : "gray"}>Google OAuth: {googleOAuthConfigured(cfg) ? "configured" : "not configured"}</Badge>
            <Badge tone="gray">Max bytes billed per query: {cfg.bigquery.maxBytesBilled.toLocaleString("en-US")}</Badge>
          </div>
          <div>
            <h3 className="mb-2 font-semibold">Resource registry (company → dataset)</h3>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="text-gray-500"><tr><th className="py-1">Company</th><th>Provider</th><th>Project</th><th>Dataset</th><th>Location</th><th>Status</th><th>Schema</th><th>Verified</th></tr></thead>
                <tbody className="divide-y divide-gray-100 font-mono">
                  {(resources ?? []).map((r) => (
                    <tr key={r.dataset_id}><td className="py-1 font-sans">{name(r.company_id)}</td><td>{r.provider}{r.is_simulated ? " (simulated)" : ""}</td><td>{r.project_id}</td><td>{r.dataset_id}</td><td>{r.location}</td><td>{r.status}</td><td>v{r.schema_version}</td><td>{r.verified_at?.slice(0, 19) ?? "—"}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          <div>
            <h3 className="mb-2 font-semibold">Provisioning jobs</h3>
            <ul className="space-y-1 text-xs">{(jobs ?? []).map((j, i) => <li key={i}>{name(j.company_id)} — {j.status} (attempts {j.attempts}){j.last_error_code ? ` — ${j.last_error_code}` : ""}</li>)}</ul>
          </div>
          {isAdmin && (
            <div>
              <h3 className="mb-2 font-semibold">Usage (this workspace)</h3>
              <p className="mb-2 text-xs text-gray-500">Costs here are <strong>estimates</strong> at list price for bytes billed by BigQuery queries, not your actual bill. The monthly free tier applies per billing account and is not subtracted. Actual cost comes from Cloud Billing export (not set up in Phase 1). In local mode no cloud cost is incurred.</p>
              <table className="text-xs"><tbody>
                {[...usageByKind.entries()].map(([k, v]) => <tr key={k}><td className="pr-4">{k}</td><td className="pr-4">{v.n} events</td><td className="pr-4">{v.q.toLocaleString("en-US")} {v.unit}</td><td className="pr-4">{v.bytes.toLocaleString("en-US")} bytes billed</td><td>est. ${v.cost.toFixed(4)}</td></tr>)}
              </tbody></table>
            </div>
          )}
          {isAdmin && (
            <div>
              <h3 className="mb-2 font-semibold">Recent audit log</h3>
              <ul className="space-y-1 text-xs">{(audit ?? []).map((a, i) => <li key={i}>{a.created_at.slice(0, 19)} — {a.actor_type} — {a.action}</li>)}</ul>
            </div>
          )}
        </div>
      </details>
    </div>
  );
}
