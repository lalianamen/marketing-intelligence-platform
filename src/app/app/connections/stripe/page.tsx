import { getManageContext } from "@/server/appContext";
import { Button, Card, EmptyState, Notice } from "@/components/ui";
import { connectStripeAction } from "../../actions";

// Stripe: the user pastes a restricted key with read-only access to balance
// transactions. Full secret keys are refused. Stored encrypted, never shown again.
export default async function StripeConnectPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const sp = await searchParams;
  const ctx = await getManageContext();
  if (!ctx.company) return <EmptyState title="Add a company first">Add a company first.</EmptyState>;
  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <div className="space-y-4 lg:col-span-2">
        <a href="/app/connections/new" className="text-sm text-brand-700 hover:underline">← Add a connector</a>
        <h1 className="text-2xl font-semibold">Connect Stripe</h1>
        {sp.error && <Notice tone="red">{sp.error}</Notice>}
        <Card title="Paste your Stripe read-only key">
          <form action={connectStripeAction} className="space-y-4 text-sm" data-testid="stripe-form" autoComplete="off">
            <input type="hidden" name="company_id" value={ctx.company.id} />
            <label className="block">
              <span className="font-medium text-gray-800">Restricted key (starts with rk_live_)</span>
              <input name="key" type="password" required pattern="rk_(live|test)_[A-Za-z0-9]{10,250}" className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 font-mono" />
              <span className="mt-1 block text-xs text-gray-500">Stored encrypted and never shown again. Delete the key in Stripe at any time to cut access.</span>
            </label>
            <Button>Check and connect</Button>
          </form>
        </Card>
      </div>
      <Card title="How to create the key (1 minute)">
        <ol className="list-decimal space-y-2 pl-5 text-sm text-gray-700">
          <li>Open <a className="font-medium text-brand-700 underline" href="https://dashboard.stripe.com/apikeys" target="_blank" rel="noopener noreferrer">Stripe → Developers → API keys</a>.</li>
          <li>Click <strong>Create restricted key</strong>. When Stripe asks how the key will be used, choose <strong>Powering an integration you built</strong> and click <strong>Continue</strong> (this option shows the list of permissions).</li>
          <li>Name it e.g. <code>marketing-platform</code>. In the list of permissions find <strong>Balance</strong> and set it to <strong>Read</strong>. Leave everything else as <strong>None</strong>.</li>
          <li>Click <strong>Create key</strong>, then <strong>Copy</strong> and paste it here.</li>
        </ol>
        <div className="mt-4 space-y-1 text-xs text-gray-500">
          <p>A read-only key can only see money movements — it cannot charge, refund or change anything. Please do not use your secret key (sk_…); the platform refuses it.</p>
          <p>Stripe keeps full history, so you can load past months too.</p>
        </div>
      </Card>
    </div>
  );
}
