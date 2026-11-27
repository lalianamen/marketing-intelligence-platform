import { getManageContext } from "@/server/appContext";
import { Button, Card, EmptyState, Notice } from "@/components/ui";
import { connectClarityAction } from "../../actions";

// Microsoft Clarity has no "sign in with Microsoft" for its data: the user pastes a
// project API token created in Clarity. It is sent only to this server, stored
// encrypted, and never shown again.
export default async function ClarityConnectPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const sp = await searchParams;
  const ctx = await getManageContext();
  if (!ctx.company) return <EmptyState title="Add a company first">Add a company first.</EmptyState>;
  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <div className="space-y-4 lg:col-span-2">
        <a href="/app/connections/new" className="text-sm text-brand-700 hover:underline">← Add a connector</a>
        <h1 className="text-2xl font-semibold">Connect Microsoft Clarity</h1>
        {sp.error && <Notice tone="red">{sp.error}</Notice>}
        <Card title="Paste your Clarity key">
          <form action={connectClarityAction} className="space-y-4 text-sm" data-testid="clarity-form" autoComplete="off">
            <input type="hidden" name="company_id" value={ctx.company.id} />
            <label className="block">
              <span className="font-medium text-gray-800">Clarity key (API token)</span>
              <input name="token" type="password" required minLength={20} className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 font-mono" />
              <span className="mt-1 block text-xs text-gray-500">Stored encrypted and never shown again. You can delete it in Clarity at any time to cut access.</span>
            </label>
            <Button>Check and connect</Button>
            <p className="text-xs text-gray-500">Checking the token uses 1 of Clarity&apos;s 10 daily requests for this project.</p>
          </form>
        </Card>
      </div>
      <Card title="How to get the key (1 minute)">
        <ol className="list-decimal space-y-2 pl-5 text-sm text-gray-700">
          <li>Open <a className="font-medium text-brand-700 underline" href="https://clarity.microsoft.com/projects" target="_blank" rel="noopener noreferrer">your Clarity projects</a> and click your site.</li>
          <li>Click <strong>Settings</strong> (gear icon) → <strong>Data Export</strong>.</li>
          <li>Click <strong>Generate new API token</strong>, type any name (e.g. <code>platform</code>) and click <strong>Generate</strong>.</li>
          <li>Click <strong>Copy</strong> and paste it into the field on this page.</li>
        </ol>
        <div className="mt-4 space-y-1 text-xs text-gray-500">
          <p>Microsoft offers no &quot;Sign in with Microsoft&quot; for Clarity data; this key is the only way it shares the numbers. It can only read statistics — it cannot change anything in Clarity — and you can delete it there at any time.</p>
          <p>Clarity shares the last 24 hours only, so the platform loads once a day right after midnight and history builds up from today.</p>
        </div>
      </Card>
    </div>
  );
}
