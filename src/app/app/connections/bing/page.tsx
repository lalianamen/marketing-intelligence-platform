import { getCompanyContext } from "@/server/appContext";
import { bingOAuthConfigured, loadConfig } from "@/server/config";
import { Button, Card, EmptyState, LinkButton, Notice } from "@/components/ui";
import { connectBingAction } from "../../actions";

// Bing Webmaster Tools. Normally one button: "Connect with Bing" (Bing's own
// sign-in screen, nothing to copy). The API-key form is the fallback when the
// platform's Bing sign-in is not configured, or when the user asks for it.
export default async function BingConnectPage({ searchParams }: { searchParams: Promise<{ error?: string; key?: string }> }) {
  const sp = await searchParams;
  const ctx = await getCompanyContext();
  if (!ctx.company) return <EmptyState title="Add a company first">Add a company first.</EmptyState>;
  if (bingOAuthConfigured(loadConfig()) && sp.key !== "1") {
    return (
      <div className="max-w-xl space-y-4">
        <a href="/app/connections/new" className="text-sm text-brand-700 hover:underline">← Add a connector</a>
        <h1 className="text-2xl font-semibold">Connect Bing</h1>
        {sp.error && <Notice tone="red">{sp.error}</Notice>}
        <Card>
          <p className="text-sm text-gray-700">Press the button and allow access on Bing&apos;s page. That&apos;s all.</p>
          <div className="mt-4">
            <LinkButton href={`/api/oauth/bing/start?company=${ctx.company.id}`}>Connect with Bing</LinkButton>
          </div>
          <p className="mt-4 text-xs text-gray-500">
            Your site must already be in{" "}
            <a className="underline" href="https://www.bing.com/webmasters" target="_blank" rel="noopener noreferrer">Bing Webmaster Tools</a>{" "}
            (the quickest way to add it: Import from Google Search Console). The platform can only read statistics.
          </p>
        </Card>
        <a href="/app/connections/bing?key=1" className="block text-xs text-gray-500 underline">Connect with an API key instead</a>
      </div>
    );
  }
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
