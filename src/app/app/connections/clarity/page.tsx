import { getCompanyContext } from "@/server/appContext";
import { Button, Card, EmptyState, Notice } from "@/components/ui";
import { connectClarityAction } from "../../actions";

// Microsoft Clarity has no "sign in with Microsoft" for its data: the user pastes a
// project API token created in Clarity. It is sent only to this server, stored
// encrypted, and never shown again.
export default async function ClarityConnectPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const sp = await searchParams;
  const ctx = await getCompanyContext();
  if (!ctx.company) return <EmptyState title="Add a company first">Add a company first.</EmptyState>;
  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <div className="space-y-4 lg:col-span-2">
        <a href="/app/connections/new" className="text-sm text-brand-700 hover:underline">← Add a connector</a>
        <h1 className="text-2xl font-semibold">Connect Microsoft Clarity</h1>
        {sp.error && <Notice tone="red">{sp.error}</Notice>}
        <Card title="Your Clarity project">
          <form action={connectClarityAction} className="space-y-4 text-sm" data-testid="clarity-form" autoComplete="off">
            <input type="hidden" name="company_id" value={ctx.company.id} />
            <label className="block">
              <span className="font-medium text-gray-800">Project ID</span>
              <input name="project_id" required pattern="[A-Za-z0-9]{6,20}" placeholder="e.g. ab12cd34ef" className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2" />
              <span className="mt-1 block text-xs text-gray-500">In Clarity: Settings → Overview → Project ID (also in the address bar after /projects/view/).</span>
            </label>
            <label className="block">
              <span className="font-medium text-gray-800">API token</span>
              <input name="token" type="password" required minLength={20} className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 font-mono" />
              <span className="mt-1 block text-xs text-gray-500">Stored encrypted and never shown again. You can delete it in Clarity at any time to cut access.</span>
            </label>
            <Button>Check and connect</Button>
            <p className="text-xs text-gray-500">Checking the token uses 1 of Clarity&apos;s 10 daily requests for this project.</p>
          </form>
        </Card>
      </div>
      <Card title="How to get the token">
        <ol className="list-decimal space-y-2 pl-5 text-sm text-gray-700">
          <li>Open <strong>clarity.microsoft.com</strong> and your site&apos;s project.</li>
          <li><strong>Settings → Data Export → Generate new API token</strong> (only project admins can).</li>
          <li>Name it e.g. <code>marketing-platform</code>, copy the token and paste it here.</li>
        </ol>
        <div className="mt-4 space-y-1 text-xs text-gray-500">
          <p>What Clarity allows: the last 24 hours only, up to 3 breakdowns and 10 requests a day. The platform loads once a day right after midnight, so history builds up from today — past days cannot be loaded.</p>
        </div>
      </Card>
    </div>
  );
}
