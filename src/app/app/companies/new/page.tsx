import { getAppContext } from "@/server/appContext";
import { Card, Field, Notice } from "@/components/ui";
import { SubmitButton } from "@/components/SubmitButton";
import { createCompanyAction } from "../../actions";
import { BUSINESS_PROFILES, BUSINESS_TYPES } from "@/lib/businessTypes";

const TIMEZONES = ["America/Los_Angeles", "America/Denver", "America/Chicago", "America/New_York", "America/Phoenix", "Pacific/Honolulu", "America/Anchorage", "Europe/London", "Europe/Berlin", "Asia/Yerevan", "Asia/Tokyo", "Australia/Sydney", "UTC"];

export default async function NewCompanyPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const sp = await searchParams;
  const ctx = await getAppContext();
  const canCreate = ["owner", "admin", "member"].includes(ctx.workspace.role);
  return (
    <div className="mx-auto max-w-xl space-y-4">
      <a href="/app/companies" className="text-sm text-brand-700 hover:underline">← All companies</a>
      <h1 className="text-2xl font-semibold">Add a company</h1>
      {sp.error && <Notice tone="red">{sp.error}</Notice>}
      <Card>
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
          <SubmitButton pendingText="Adding…">Add company</SubmitButton>
        </form>
        ) : (
          <p className="text-sm text-gray-600">Your role cannot add companies.</p>
        )}
      </Card>
    </div>
  );
}
