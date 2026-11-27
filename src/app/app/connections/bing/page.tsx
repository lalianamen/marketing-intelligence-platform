import { getCompanyContext } from "@/server/appContext";
import { Button, Card, EmptyState, Notice } from "@/components/ui";
import { connectBingAction } from "../../actions";

// Bing Webmaster Tools: the user pastes their Bing Webmaster API key. It is sent
// only to this server, stored encrypted, and never shown again.
export default async function BingConnectPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const sp = await searchParams;
  const ctx = await getCompanyContext();
  if (!ctx.company) return <EmptyState title="Add a company first">Add a company first.</EmptyState>;
  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <div className="space-y-4 lg:col-span-2">
        <a href="/app/connections/new" className="text-sm text-brand-700 hover:underline">← Add a connector</a>
        <h1 className="text-2xl font-semibold">Connect Bing Webmaster Tools</h1>
        {sp.error && <Notice tone="red">{sp.error}</Notice>}
        <Card title="Paste your Bing Webmaster API key">
          <form action={connectBingAction} className="space-y-4 text-sm" data-testid="bing-form" autoComplete="off">
            <input type="hidden" name="company_id" value={ctx.company.id} />
            <label className="block">
              <span className="font-medium text-gray-800">API key</span>
              <input name="key" type="password" required pattern="[A-Za-z0-9]{16,64}" className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 font-mono" />
              <span className="mt-1 block text-xs text-gray-500">Stored encrypted and never shown again.</span>
            </label>
            <label className="block">
              <span className="font-medium text-gray-800">Site <span className="font-normal text-gray-500">(only if you have several sites in Bing)</span></span>
              <input name="site" type="text" placeholder={ctx.company.website ?? "https://example.com/"} maxLength={300} className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2" />
            </label>
            <Button>Check and connect</Button>
          </form>
        </Card>
      </div>
      <Card title="How to get the key (1 minute)">
        <ol className="list-decimal space-y-2 pl-5 text-sm text-gray-700">
          <li>Open <a className="font-medium text-brand-700 underline" href="https://www.bing.com/webmasters" target="_blank" rel="noopener noreferrer">Bing Webmaster Tools</a> and sign in. If your site is not there yet, add it — the quickest way is <strong>Import from Google Search Console</strong>.</li>
          <li>Click <strong>Settings</strong> (gear icon, top right) → <strong>API Access</strong>.</li>
          <li>Accept the terms if asked and click <strong>Generate API Key</strong> (or <strong>View API Key</strong> if you already have one).</li>
          <li>Copy the key and paste it here.</li>
        </ol>
        <div className="mt-4 space-y-1 text-xs text-gray-500">
          <p>The platform only reads statistics with this key. Bing gives one key per account for all your sites; generating a new key in Bing cuts this connection (reconnect with the new key).</p>
          <p>Bing shares only the history it keeps; older days stay empty. Top queries and pages are refreshed by Bing once a week.</p>
        </div>
      </Card>
    </div>
  );
}
