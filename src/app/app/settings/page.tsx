import { getCompanyContext } from "@/server/appContext";
import { Button, Card, Field, Notice } from "@/components/ui";
import { updateCompanyAction } from "../actions";
import { DeleteCompanyButton } from "@/components/DeleteCompanyButton";
import { BUSINESS_PROFILES, BUSINESS_TYPES } from "@/lib/businessTypes";

export default async function CompanySettingsPage({ searchParams }: { searchParams: Promise<{ saved?: string; error?: string }> }) {
  const sp = await searchParams;
  const ctx = await getCompanyContext();
  const isAdmin = ["owner", "admin"].includes(ctx.workspace.role);
  return (
    <div className="max-w-2xl space-y-6">
      <h1 className="text-2xl font-semibold">Company settings</h1>
      {sp.saved && <Notice tone="green">Saved.</Notice>}
      {sp.error && <Notice tone="red">{sp.error}</Notice>}
      <Card title="Company details">
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

      {isAdmin && (
        <section className="rounded-xl border border-red-200 bg-white p-5" data-testid="delete-company">
          <h2 className="text-base font-semibold text-red-800">Delete company “{ctx.company.name}”</h2>
          <p className="mt-1 text-sm text-gray-700">
            All data of this company will be permanently deleted from the database: its data space with every imported and synced number, uploaded files, connections and stored sign-ins. It cannot be undone.
          </p>
          <div className="mt-3"><DeleteCompanyButton companyId={ctx.company.id} companyName={ctx.company.name} /></div>
        </section>
      )}
    </div>
  );
}
