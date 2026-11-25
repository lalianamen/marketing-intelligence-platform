import { getCompanyContext } from "@/server/appContext";
import { getUser } from "@/server/supabase/server";
import { dataSpaceStatus, loadConnections, PROVIDER_LABEL } from "@/server/companyStatus";
import { googleOAuthConfigured, loadConfig } from "@/server/config";
import { Badge, Button, Card, LinkButton, Notice } from "@/components/ui";
import { enableSampleConnectionAction } from "../../actions";
import { profileFor } from "@/lib/businessTypes";

export default async function AddConnectorPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const sp = await searchParams;
  const ctx = await getCompanyContext();
  const { supabase } = await getUser();
  const company = ctx.company;
  const space = (await dataSpaceStatus(supabase, [company.id]))[company.id]!;
  const { connections } = await loadConnections(supabase, company.id);
  const { data: providers } = await supabase.from("connector_providers").select("id,display_name,availability,description").order("display_name");
  const oauthReady = googleOAuthConfigured(loadConfig());
  const profile = profileFor(company.business_type);
  const providerById = new Map((providers ?? []).map((p) => [p.id, p]));
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

      <div className="grid gap-4 md:grid-cols-3">
        <Card title="Upload a spreadsheet (CSV)" actions={<Badge tone="green">Available</Badge>}>
          <p className="text-sm text-gray-600">Works for any platform (Meta, Microsoft Ads, Yelp reports, your CRM…). Use our template so numbers are read correctly.</p>
          <div className="mt-4 flex flex-wrap gap-2">
            <LinkButton href="/app/connections/csv">Upload CSV</LinkButton>
            <LinkButton href="/sample-marketing-data.csv" variant="secondary">Download template</LinkButton>
          </div>
        </Card>
        {(["ga4", "google_ads"] as const).map((p) => (
          <Card key={p} title={PROVIDER_LABEL[p]} actions={live(p) ? <Badge tone="green">Connected</Badge> : sample(p) ? <Badge tone="amber">Sample data on</Badge> : <Badge tone="gray">Not connected</Badge>}>
            <p className="text-sm text-gray-600">
              {p === "ga4" ? "Daily website report numbers: sessions, key events and GA4-reported revenue." : "Daily campaign numbers: cost, impressions, clicks and Google Ads conversions."}
            </p>
            <div className="mt-4 space-y-2">
              {oauthReady ? (
                <>
                  <form action="/api/oauth/google/start" method="get">
                    <input type="hidden" name="provider" value={p} />
                    <input type="hidden" name="company" value={company.id} />
                    <Button disabled={space.status !== "ready"}>Connect with Google</Button>
                    <p className="mt-2 text-xs text-gray-500">Sign in with Google and we find your {p === "ga4" ? "Analytics properties" : "Google Ads accounts"} automatically.</p>
                  </form>
                  <details className="text-xs text-gray-500">
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
                  </details>
                </>
              ) : (
                <p className="text-xs text-gray-500">
                  Live connection is not set up yet: an administrator must configure Google sign-in for this app first (see docs/CONNECTORS.md).
                </p>
              )}
              {!sample(p) && (
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

      <Card title={`Recommended for a ${profile.label.toLowerCase()}`}>
        <p className="mb-3 text-sm text-gray-600">In order of usefulness for this kind of business. You sign in to each with your own account; we never ask for your passwords.</p>
        <ol className="grid gap-2 text-sm sm:grid-cols-2 lg:grid-cols-4" data-testid="recommended-sources">
          {profile.recommendedSources.map((id, i) => {
            const p = providerById.get(id);
            if (!p) return null;
            const connected = connections.some((c) => c.provider_id === id);
            const state =
              connected ? { tone: "green" as const, text: "Connected" }
              : id === "csv" ? { tone: "green" as const, text: "Available now" }
              : p.availability === "requires_admin_setup" ? { tone: "blue" as const, text: oauthReady ? "Available" : "Sample data now · live soon" }
              : p.availability === "requires_partner_access" ? { tone: "red" as const, text: "Requires partner access" }
              : { tone: "gray" as const, text: "Coming later · use CSV" };
            return (
              <li key={id} className="rounded-lg border border-gray-200 p-3">
                <div className="flex items-start justify-between gap-2"><span className="font-medium">{i + 1}. {p.display_name}</span><Badge tone={state.tone}>{state.text}</Badge></div>
              </li>
            );
          })}
        </ol>
        {profile.csvTips.length > 0 && <p className="mt-3 text-xs text-gray-500">CSV tip: {profile.csvTips.join(" ")}</p>}
      </Card>

      <Card title="Other platforms">
        <p className="mb-3 text-sm text-gray-600">Direct connections for these platforms are not available yet. Upload their reports as CSV meanwhile.</p>
        <ul className="grid gap-2 text-sm sm:grid-cols-2 lg:grid-cols-3">
          {(providers ?? []).filter((p) => !["csv", "ga4", "google_ads"].includes(p.id) && !profile.recommendedSources.includes(p.id)).map((p) => (
            <li key={p.id} className="rounded-lg border border-gray-200 p-3">
              <div className="flex items-center justify-between"><span className="font-medium">{p.display_name}</span>
                <Badge tone={p.availability === "requires_partner_access" ? "red" : "gray"}>{p.availability === "requires_partner_access" ? "Requires partner access" : "Planned"}</Badge></div>
              <p className="mt-1 text-xs text-gray-500">{p.description}</p>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
