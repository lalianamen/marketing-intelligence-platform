import { redirect } from "next/navigation";
import { getCompanyContext } from "@/server/appContext";
import { getPool } from "@/server/db";
import type { DiscoveredAccount } from "@/server/connectors/google";
import { Card, Notice } from "@/components/ui";
import { SubmitButton } from "@/components/SubmitButton";
import { chooseGoogleAccountsAction } from "../../actions";

// Shown after Google sign-in when the Google user can read several GA4
// properties / Google Ads accounts. Reads the pending grant with the server
// pool, scoped to the signed-in user; the token itself never reaches the page.
export default async function ChooseAccountsPage({ searchParams }: { searchParams: Promise<{ grant?: string; error?: string }> }) {
  const sp = await searchParams;
  const ctx = await getCompanyContext();
  const grantId = sp.grant ?? "";
  const row = /^[0-9a-f-]{36}$/i.test(grantId)
    ? (
        await getPool().query<{ provider_id: string; accounts: DiscoveredAccount[]; company_id: string }>(
          `select provider_id, accounts, company_id from public.oauth_pending_grants where id = $1 and user_id = $2 and expires_at > now()`,
          [grantId, ctx.userId],
        )
      ).rows[0]
    : undefined;
  if (!row || row.company_id !== ctx.company.id) redirect("/app/connections?oauth=" + encodeURIComponent("This connection attempt expired. Please try again."));
  const isGa4 = row.provider_id === "ga4";
  const isGsc = row.provider_id === "google_search_console";
  const isBing = row.provider_id === "bing_webmaster";
  const isMeta = row.provider_id === "meta_ads";
  const sitesWord = isBing ? "Bing sites" : "Search Console sites";
  const groups = new Map<string, DiscoveredAccount[]>();
  for (const a of row.accounts) {
    const k = a.group ?? "";
    groups.set(k, [...(groups.get(k) ?? []), a]);
  }

  return (
    <div className="max-w-2xl space-y-4">
      <div>
        <a href="/app/connections" className="text-sm text-brand-700 hover:underline">← Data Connections</a>
        <h1 className="mt-1 text-2xl font-semibold">Choose {isMeta ? "Meta ad accounts" : isGa4 ? "Google Analytics properties" : isGsc || isBing ? sitesWord : "Google Ads accounts"}</h1>
        <p className="text-sm text-gray-600">
          Your {isMeta ? "Facebook" : isBing ? "Bing" : "Google"} account has access to {row.accounts.length} {isMeta ? "ad accounts" : isGa4 ? "properties" : isGsc || isBing ? "sites" : "accounts"}. Pick the ones that belong to <strong>{ctx.company.name}</strong>.
        </p>
      </div>
      {sp.error && <Notice tone="red">Please choose at least one.</Notice>}
      <Card>
        <form action={chooseGoogleAccountsAction} className="space-y-4">
          <input type="hidden" name="grant" value={grantId} />
          {[...groups.entries()].map(([group, items]) => (
            <fieldset key={group} className="space-y-1.5">
              {group && <legend className="mb-1 text-xs font-semibold uppercase text-gray-500">{group}</legend>}
              {items.map((a, i) => (
                <label key={a.id} className="flex cursor-pointer items-center gap-3 rounded-lg border border-gray-200 p-3 text-sm hover:bg-gray-50">
                  <input type="checkbox" name="account" value={a.id} defaultChecked={row.accounts.length <= 3 || (i === 0 && groups.size === 1)} />
                  <span className="flex-1">
                    <span className="font-medium text-gray-900">{a.name}</span>
                    <span className="block text-xs text-gray-500">{isMeta ? `Ad account ${a.id.replace(/^act_/, "")}` : isBing ? "Bing site" : isGsc ? "Search Console site" : isGa4 ? `Property ID ${a.id}` : `Customer ID ${a.id.replace(/(\d{3})(\d{3})(\d{4})/, "$1-$2-$3")}`}</span>
                  </span>
                </label>
              ))}
            </fieldset>
          ))}
          <SubmitButton pendingText="Connecting…">Connect selected</SubmitButton>
        </form>
      </Card>
    </div>
  );
}
