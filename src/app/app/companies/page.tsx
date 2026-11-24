import { getAppContext } from "@/server/appContext";
import { getUser } from "@/server/supabase/server";
import { dataSpaceStatus, type DataSpaceStatus } from "@/server/companyStatus";
import { AutoRefresh } from "@/components/AutoRefresh";
import { Badge, Button, EmptyState, LinkButton, Notice } from "@/components/ui";
import { retryProvisioningAction } from "../actions";
import { profileFor } from "@/lib/businessTypes";

const STATUS: Record<DataSpaceStatus, { tone: "gray" | "blue" | "green" | "red"; text: string; help: string }> = {
  pending: { tone: "gray", text: "Preparing", help: "Waiting for the background worker to prepare the data space." },
  preparing: { tone: "blue", text: "Preparing", help: "Creating the company's private data space." },
  ready: { tone: "green", text: "Ready", help: "The data space is ready." },
  failed: { tone: "red", text: "Failed", help: "Preparing the data space failed. You can retry." },
};

export default async function CompaniesPage({ searchParams }: { searchParams: Promise<{ error?: string; created?: string; deleted?: string }> }) {
  const sp = await searchParams;
  const ctx = await getAppContext();
  const { supabase } = await getUser();
  const statuses = await dataSpaceStatus(supabase, ctx.companies.map((c) => c.id));
  const pending = Object.values(statuses).some((s) => s.status === "pending" || s.status === "preparing");
  const canCreate = ["owner", "admin", "member"].includes(ctx.workspace.role);

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">Companies</h1>
        {canCreate && <LinkButton href="/app/companies/new">+ Add company</LinkButton>}
      </div>
      {sp.error && <Notice tone="red">{sp.error}</Notice>}
      {sp.deleted && <Notice tone="green">Company deleted. Its data space is being removed in the background.</Notice>}
      {sp.created && <Notice tone="green">Company added. We are preparing its private data space — this page updates automatically.</Notice>}
      <AutoRefresh active={pending} />
      {ctx.companies.length === 0 ? (
        <EmptyState title="No companies yet">
          Add your first company to start collecting its marketing data. If you manage several businesses, add each one separately — their data is always kept apart.
          {canCreate && <div className="mt-4"><LinkButton href="/app/companies/new">+ Add company</LinkButton></div>}
        </EmptyState>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2">
          {ctx.companies.map((c) => {
            const s = statuses[c.id]!;
            const meta = STATUS[s.status];
            return (
              <li key={c.id} className="relative rounded-xl border border-gray-200 bg-white transition hover:border-brand-300 hover:shadow-sm" data-testid="company-row">
                <a href={`/app/companies/${c.id}/open`} className="block p-4" aria-label={`Open ${c.name}`}>
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-lg font-semibold text-gray-900">{c.name}</p>
                      <p className="text-sm text-gray-500">{profileFor(c.business_type).label}</p>
                      {c.website && <p className="truncate text-xs text-gray-400">{c.website.replace(/^https?:\/\//, "").replace(/\/$/, "")}</p>}
                    </div>
                    <span className="text-xl text-gray-300" aria-hidden>›</span>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Badge tone={meta.tone} title={meta.help}>{meta.text}</Badge>
                    {s.status === "ready" && s.simulated && (
                      <Badge tone="amber" title="Stored in the local simulated warehouse, not in Google BigQuery.">Simulated warehouse</Badge>
                    )}
                  </div>
                </a>
                {s.status === "failed" && (
                  <form action={retryProvisioningAction} className="border-t border-gray-100 px-4 py-3">
                    <input type="hidden" name="company_id" value={c.id} />
                    <p className="mb-2 text-xs text-gray-500">Reason code: {s.error}</p>
                    <Button variant="secondary">Retry</Button>
                  </form>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
