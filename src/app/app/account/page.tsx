import { getAppContext } from "@/server/appContext";
import { getUser } from "@/server/supabase/server";
import { googleOAuthConfigured, loadConfig } from "@/server/config";
import { Badge, Button, Card, Field, Notice } from "@/components/ui";
import { inviteUserAction, removeMemberAction, renameWorkspaceAction, revokeInvitationAction, setMemberAccessAction, setThemeAction } from "../actions";
import { getPool } from "@/server/db";
import { loadTeam, ROLE_LABEL } from "@/server/team/team";
import { cookies } from "next/headers";

export default async function AccountPage({ searchParams }: { searchParams: Promise<{ saved?: string; error?: string; invited?: string; users_error?: string; users_saved?: string }> }) {
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
  const theme = (await cookies()).get("theme")?.value ?? "light";
  const team = isAdmin ? await loadTeam(getPool(), ctx.userId, ctx.workspace.id) : null;
  const ownCompanies = ctx.companies.filter((c) => c.workspace_id === ctx.workspace.id);

  return (
    <div className="space-y-6">
      <div>
        <a href="/app/companies" className="text-sm text-brand-700 hover:underline">← All companies</a>
        <h1 className="mt-1 text-2xl font-semibold">Account settings</h1>
      </div>
      {sp.saved && <Notice tone="green">Saved.</Notice>}
      {sp.error && <Notice tone="red">{sp.error}</Notice>}
      <div className="grid gap-4 md:grid-cols-2">
        <Card title="Your account">
          <p className="text-xs text-gray-500">Signed in as</p>
          <p className="text-sm font-medium text-gray-900">{ctx.email}</p>
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
        </Card>
        <Card title="Appearance">
          <form action={setThemeAction} id="appearance" className="space-y-3 text-sm" data-testid="appearance">
            <fieldset className="flex flex-wrap gap-4">
              <legend className="mb-2 text-xs text-gray-500">Theme</legend>
              {([["light", "Light"], ["dark", "Dark"], ["system", "Same as my device"]] as const).map(([v, label]) => (
                <label key={v} className="flex cursor-pointer items-center gap-2">
                  <input type="radio" name="theme" value={v} defaultChecked={theme === v} />
                  {label}
                </label>
              ))}
            </fieldset>
            <Button variant="secondary">Save</Button>
          </form>
        </Card>
      </div>


      {team && (
        <section id="users" className="space-y-4 rounded-xl border border-gray-200 bg-white p-5" data-testid="users">
          <div>
            <h2 className="text-base font-semibold">Users</h2>
            <p className="text-sm text-gray-600">Give other people access to the companies you choose. They see nothing else.</p>
          </div>
          {sp.users_error && <Notice tone="red">{sp.users_error}</Notice>}
          {sp.users_saved && <Notice tone="green">Saved.</Notice>}
          {sp.invited && (
            <Notice tone="green">
              Done. Tell <strong>{sp.invited}</strong> to open <strong>{cfg.appUrl}/signup</strong> (or log in, if they already have an account) with this email.
              The chosen companies appear in their list right away.
            </Notice>
          )}

          {ownCompanies.length === 0 ? (
            <p className="text-sm text-gray-600">Add a company first.</p>
          ) : (
            <form action={inviteUserAction} className="space-y-4 rounded-lg border border-gray-200 p-4 text-sm" data-testid="invite-form">
              <h3 className="font-semibold">Add a person</h3>
              <Field label="Their email" name="email" type="email" required />
              <fieldset className="space-y-2">
                <legend className="mb-1 font-medium text-gray-800">What can they do?</legend>
                <label className="flex cursor-pointer items-start gap-2">
                  <input type="radio" name="role" value="company_viewer" defaultChecked className="mt-1" />
                  <span><strong>Viewer</strong> — sees the dashboard and data, cannot change anything.</span>
                </label>
                <label className="flex cursor-pointer items-start gap-2">
                  <input type="radio" name="role" value="company_admin" className="mt-1" />
                  <span><strong>Editor</strong> — also connects sources, uploads files and changes company settings. Cannot delete companies or add people.</span>
                </label>
              </fieldset>
              <fieldset className="space-y-1.5">
                <legend className="mb-1 font-medium text-gray-800">Which companies?</legend>
                {ownCompanies.map((c) => (
                  <label key={c.id} className="flex cursor-pointer items-center gap-2">
                    <input type="checkbox" name="company" value={c.id} defaultChecked={ownCompanies.length === 1 || c.id === ctx.company?.id} />
                    {c.name}
                  </label>
                ))}
              </fieldset>
              <Button>Give access</Button>
            </form>
          )}

          {team.members.length > 0 && (
            <div className="space-y-3">
              <h3 className="text-sm font-semibold">People with access</h3>
              {team.members.map((m) => (
                <div key={m.userId} className="rounded-lg border border-gray-200 p-3 text-sm">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-medium text-gray-900">{m.email}</span>
                    <form action={removeMemberAction}>
                      <input type="hidden" name="user_id" value={m.userId} />
                      <button className="text-xs text-red-700 hover:underline">Remove from all companies</button>
                    </form>
                  </div>
                  <ul className="mt-2 divide-y divide-gray-100">
                    {m.companies.map((c) => (
                      <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 py-1.5">
                        <span>{c.name}</span>
                        <form action={setMemberAccessAction} className="flex items-center gap-2">
                          <input type="hidden" name="user_id" value={m.userId} />
                          <input type="hidden" name="company_id" value={c.id} />
                          <select name="role" defaultValue={c.role} className="rounded-lg border border-gray-300 px-2 py-1 text-xs" aria-label={`Role in ${c.name}`}>
                            <option value="company_viewer">Viewer</option>
                            <option value="company_admin">Editor</option>
                            <option value="remove">No access</option>
                          </select>
                          <button className="rounded-lg border border-gray-300 px-2 py-1 text-xs hover:bg-gray-50">Save</button>
                        </form>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          )}

          {team.invitations.length > 0 && (
            <div className="space-y-2">
              <h3 className="text-sm font-semibold">Waiting to sign up</h3>
              <ul className="divide-y divide-gray-100 text-sm">
                {team.invitations.map((i) => (
                  <li key={i.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                    <span>
                      <span className="font-medium">{i.email}</span> · {ROLE_LABEL[i.role]} · {i.companies.map((c) => c.name).join(", ")}
                      <span className="block text-xs text-gray-500">Valid until {i.expiresAt}. Access starts when they sign up with this email.</span>
                    </span>
                    <form action={revokeInvitationAction}>
                      <input type="hidden" name="invitation_id" value={i.id} />
                      <button className="text-xs text-red-700 hover:underline">Cancel</button>
                    </form>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>
      )}

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
