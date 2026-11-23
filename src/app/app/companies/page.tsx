import { getAppContext } from "@/server/appContext";
import { getUser } from "@/server/supabase/server";
import { dataSpaceStatus, type DataSpaceStatus } from "@/server/companyStatus";
import { AutoRefresh } from "@/components/AutoRefresh";
import { Badge, Button, Card, EmptyState, Field, Notice } from "@/components/ui";
import { createCompanyAction, retryProvisioningAction } from "../actions";
import { BUSINESS_PROFILES, BUSINESS_TYPES, profileFor } from "@/lib/businessTypes";

const STATUS: Record<DataSpaceStatus, { tone: "gray" | "blue" | "green" | "red"; text: string; help: string }> = {
  pending: { tone: "gray", text: "Pending", help: "Waiting for the background worker to prepare the data space." },
  preparing: { tone: "blue", text: "Preparing", help: "Creating the company's private data space." },
  ready: { tone: "green", text: "Ready", help: "The data space is ready. You can connect sources or upload data." },
  failed: { tone: "red", text: "Failed", help: "Preparing the data space failed. You can retry." },
};

const TIMEZONES = ["America/Los_Angeles", "America/Denver", "America/Chicago", "America/New_York", "America/Phoenix", "Pacific/Honolulu", "America/Anchorage", "Europe/London", "Europe/Berlin", "Asia/Yerevan", "Asia/Tokyo", "Australia/Sydney", "UTC"];

export default async function CompaniesPage({ searchParams }: { searchParams: Promise<{ error?: string; created?: string }> }) {
  const sp = await searchParams;
  const ctx = await getAppContext();
  const { supabase } = await getUser();
  const statuses = await dataSpaceStatus(supabase, ctx.companies.map((c) => c.id));
  const pending = Object.values(statuses).some((s) => s.status === "pending" || s.status === "preparing");
  const canCreate = ["owner", "admin", "member"].includes(ctx.workspace.role);

  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <div className="space-y-4 lg:col-span-2">
        <h1 className="text-2xl font-semibold">Companies</h1>
        {sp.error && <Notice tone="red">{sp.error}</Notice>}
        {sp.created && <Notice tone="green">Company added. We are preparing its private data space — this page updates automatically.</Notice>}
        <AutoRefresh active={pending} />
        {ctx.companies.length === 0 ? (
          <EmptyState title="No companies yet">Add your first company to start collecting its marketing data. If you manage several businesses, add each one separately — their data is always kept apart.</EmptyState>
        ) : (
          <ul className="space-y-3">
            {ctx.companies.map((c) => {
              const s = statuses[c.id]!;
              const meta = STATUS[s.status];
              return (
                <li key={c.id} className="rounded-xl border border-gray-200 bg-white p-4" data-testid="company-row">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <p className="font-medium text-gray-900">{c.name}</p>
                      <p className="text-xs text-gray-500">{[profileFor(c.business_type).label, c.website, c.industry, c.country, c.timezone].filter(Boolean).join(" · ")}</p>
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge tone={meta.tone} title={meta.help}>Data space: {meta.text}</Badge>
                      {s.status === "ready" && s.simulated && (
                        <Badge tone="amber" title="Stored in the local simulated warehouse, not in Google BigQuery.">SIMULATED warehouse</Badge>
                      )}
                    </div>
                  </div>
                  <p className="mt-2 text-sm text-gray-600">{meta.help}</p>
                  {s.status === "failed" && (
                    <form action={retryProvisioningAction} className="mt-3">
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
      <Card title="Add a company">
        {canCreate ? (
          <form action={createCompanyAction} className="space-y-3">
            <input type="hidden" name="workspace_id" value={ctx.workspace.id} />
            <Field label="Company name" name="name" required />
            <fieldset>
              <legend className="text-sm font-medium text-gray-800">What kind of business is it?</legend>
              <p className="mb-2 text-xs text-gray-500">We use this to suggest the right data sources and show the most useful numbers first.</p>
              <div className="space-y-1.5">
                {BUSINESS_TYPES.map((t, i) => (
                  <label key={t} className="flex cursor-pointer gap-2 rounded-lg border border-gray-200 p-2 text-sm hover:bg-gray-50">
                    <input type="radio" name="business_type" value={t} defaultChecked={i === 0} className="mt-1" />
                    <span><span className="font-medium">{BUSINESS_PROFILES[t].label}</span><span className="block text-xs text-gray-500">{BUSINESS_PROFILES[t].description}</span></span>
                  </label>
                ))}
              </div>
            </fieldset>
            <Field label="Website" name="website" placeholder="example.com" />
            <Field label="Industry" name="industry" placeholder="e.g. HVAC services" />
            <Field label="Country" name="country" placeholder="US" hint="Two-letter country code." />
            <label className="block">
              <span className="text-sm font-medium text-gray-800">Time zone <span className="font-normal text-gray-500">(optional)</span></span>
              <select name="timezone" defaultValue="America/Los_Angeles" className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm">
                {TIMEZONES.map((t) => <option key={t}>{t}</option>)}
              </select>
              <span className="mt-1 block text-xs text-gray-500">Used for daily reports and the nightly update time.</span>
            </label>
            <Button>Add company</Button>
          </form>
        ) : (
          <p className="text-sm text-gray-600">Your role cannot add companies.</p>
        )}
      </Card>
    </div>
  );
}
