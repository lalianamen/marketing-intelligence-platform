import { getManageContext } from "@/server/appContext";
import { getUser } from "@/server/supabase/server";
import { dataSpaceStatus, loadConnections, PROVIDER_LABEL } from "@/server/companyStatus";
import { bingOAuthConfigured, googleOAuthConfigured, loadConfig, metaOAuthConfigured } from "@/server/config";
import { Badge, Button, Card, LinkButton, Notice } from "@/components/ui";
import { enableSampleConnectionAction } from "../../actions";

export default async function AddConnectorPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const sp = await searchParams;
  const ctx = await getManageContext();
  const { supabase } = await getUser();
  const company = ctx.company;
  const space = (await dataSpaceStatus(supabase, [company.id]))[company.id]!;
  const { connections } = await loadConnections(supabase, company.id);
  const cfg = loadConfig();
  const oauthReady = googleOAuthConfigured(cfg);
  const bingReady = bingOAuthConfigured(cfg);
  const metaReady = metaOAuthConfigured(cfg);
  // Only what can be connected today. Sample data is offered only where live Google sign-in is not configured
  // (local development); Google Ads only once its API access for real accounts is approved (GOOGLE_ADS_ENABLED).
  // Search Console has no sample data: shown only when live Google sign-in works.
  const providersNow = (["ga4", "google_search_console", "google_ads"] as const).filter((p) =>
    p === "ga4" ? true : p === "google_search_console" ? oauthReady : cfg.google.adsEnabled || !oauthReady,
  );
  const live = (p: string) => connections.find((c) => c.provider_id === p && c.mode === "live");
  const sample = (p: string) => connections.find((c) => c.provider_id === p && c.mode === "simulated");

  return (
    <div className="space-y-6">
      <div>
        <a href="/app/connections" className="text-sm text-brand-700 hover:underline">← Data Connections</a>
        <h1 className="mt-1 text-2xl font-semibold">Add a connector</h1>
        <p className="text-sm text-gray-600">Choose where <strong>{company.name}</strong>&apos;s data comes from. You sign in to each with your own account; we never ask for your passwords.</p>
      </div>
      {sp.error && <Notice tone="red">{sp.error}</Notice>}
      {space.status !== "ready" && <Notice tone="blue">This company&apos;s data space is still being prepared ({space.status}). You can add data once it is ready.</Notice>}

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        <Card title="Upload a spreadsheet (CSV)" actions={<Badge tone="green">Available</Badge>}>
          <p className="text-sm text-gray-600">For any other platform (Meta, Stripe, your CRM…): export a report and upload it. Use our template so numbers are read correctly.</p>
          <div className="mt-4 flex flex-wrap gap-2">
            <LinkButton href="/app/connections/csv">Upload CSV</LinkButton>
            <LinkButton href="/sample-marketing-data.csv" variant="secondary">Download template</LinkButton>
          </div>
        </Card>
        <Card title="Stripe" actions={connections.some((c) => c.provider_id === "stripe" && c.mode === "live") ? <Badge tone="green">Connected</Badge> : <Badge tone="gray">Not connected</Badge>}>
          <p className="text-sm text-gray-600">Money actually received: payments, refunds, disputes, fees and payouts. Feeds billed revenue on the dashboard.</p>
          <div className="mt-4">
            <LinkButton href="/app/connections/stripe">Connect with a read-only key</LinkButton>
            <p className="mt-2 text-xs text-gray-500">You create the key in Stripe (Developers → API keys). Takes a minute.</p>
          </div>
        </Card>
        {metaReady && (
          <Card title="Meta Ads (Facebook + Instagram)" actions={live("meta_ads") ? <Badge tone="green">Connected</Badge> : <Badge tone="gray">Not connected</Badge>}>
            <p className="text-sm text-gray-600">Spend, impressions, clicks, purchases and leads of your Facebook and Instagram ads, per campaign and day.</p>
            <div className="mt-4">
              <LinkButton href={`/api/oauth/meta/start?company=${company.id}`}>Connect with Facebook</LinkButton>
              <p className="mt-2 text-xs text-gray-500">Sign in with the Facebook account that runs your ads. Read only.</p>
            </div>
          </Card>
        )}
        <Card title="Bing Webmaster Tools" actions={connections.some((c) => c.provider_id === "bing_webmaster" && c.mode === "live") ? <Badge tone="green">Connected</Badge> : <Badge tone="gray">Not connected</Badge>}>
          <p className="text-sm text-gray-600">Clicks and impressions of your site on Bing per day, with top search queries or pages. Adds to the dashboard&apos;s search totals.</p>
          <div className="mt-4">
            {bingReady ? (
              <LinkButton href={`/api/oauth/bing/start?company=${company.id}`}>Connect with Bing</LinkButton>
            ) : (
              <>
                <LinkButton href="/app/connections/bing">Connect with an API key</LinkButton>
                <p className="mt-2 text-xs text-gray-500">You get the key in Bing Webmaster (Settings → API Access). Takes a minute.</p>
              </>
            )}
          </div>
        </Card>
        <Card title="Microsoft Clarity" actions={connections.some((c) => c.provider_id === "microsoft_clarity" && c.mode === "live") ? <Badge tone="green">Connected</Badge> : <Badge tone="gray">Not connected</Badge>}>
          <p className="text-sm text-gray-600">How visitors behave on your site: sessions, scroll depth, engagement time, rage and dead clicks, script errors.</p>
          <div className="mt-4">
            <LinkButton href="/app/connections/clarity">Connect with an API token</LinkButton>
            <p className="mt-2 text-xs text-gray-500">You create the token in Clarity (Settings → Data Export). Takes a minute.</p>
          </div>
        </Card>
        {providersNow.map((p) => (
          <Card key={p} title={PROVIDER_LABEL[p]} actions={live(p) ? <Badge tone="green">Connected</Badge> : sample(p) ? <Badge tone="amber">Sample data on</Badge> : <Badge tone="gray">Not connected</Badge>}>
            <p className="text-sm text-gray-600">
              {p === "ga4"
                ? "Daily website report numbers: sessions, key events and GA4-reported revenue."
                : p === "google_search_console"
                ? "How your site shows up in Google Search: clicks, impressions and position by search query, page, country and device."
                : "Daily campaign numbers: cost, impressions, clicks and Google Ads conversions."}
            </p>
            <div className="mt-4 space-y-2">
              {oauthReady ? (
                <>
                  <form action="/api/oauth/google/start" method="get">
                    <input type="hidden" name="provider" value={p} />
                    <input type="hidden" name="company" value={company.id} />
                    <Button disabled={space.status !== "ready"}>Connect with Google</Button>
                    <p className="mt-2 text-xs text-gray-500">Sign in with Google and we find your {p === "ga4" ? "Analytics properties" : p === "google_search_console" ? "Search Console sites" : "Google Ads accounts"} automatically.</p>
                  </form>
                  {p !== "google_search_console" && <details className="text-xs text-gray-500">
                    <summary className="cursor-pointer">Enter the ID manually instead</summary>
                    <form action="/api/oauth/google/start" method="get" className="mt-2 space-y-2">
                      <input type="hidden" name="provider" value={p} />
                      <input type="hidden" name="company" value={company.id} />
                      <label className="block">
                        {p === "ga4" ? "GA4 property ID (Admin → Property details)" : "Google Ads customer ID (123-456-7890)"}
                        <input name="account" required pattern={p === "ga4" ? "[0-9]{1,20}" : "[0-9]{3}-?[0-9]{3}-?[0-9]{4}"} className="mt-1 block w-full rounded border border-gray-300 px-2 py-1 text-sm" />
                      </label>
                      <Button variant="secondary" disabled={space.status !== "ready"}>Connect this ID</Button>
                    </form>
                  </details>}
                </>
              ) : (
                <p className="text-xs text-gray-500">
                  Live connection is not set up yet: an administrator must configure Google sign-in for this app first (see docs/CONNECTORS.md).
                </p>
              )}
              {!oauthReady && !sample(p) && (
                <form action={enableSampleConnectionAction}>
                  <input type="hidden" name="company_id" value={company.id} />
                  <input type="hidden" name="provider_id" value={p} />
                  <Button variant="secondary" disabled={space.status !== "ready"}>Try with sample data</Button>
                </form>
              )}
            </div>
          </Card>
        ))}
      </div>

    </div>
  );
}
