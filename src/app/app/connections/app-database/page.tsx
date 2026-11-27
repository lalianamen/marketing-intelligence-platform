import { getManageContext } from "@/server/appContext";
import { getPool } from "@/server/db";
import { loadConfig } from "@/server/config";
import { decryptSecret } from "@/server/crypto";
import { decodeSecret, readerScript } from "@/server/connectors/appDatabase";
import { Button, Card, Notice } from "@/components/ui";
import { SubmitButton } from "@/components/SubmitButton";
import { checkAppDbAction, startAppDbAction } from "../../actions";

// Your app's database (Supabase). Step 1: paste the pooler connection string (it has no
// password). Step 2: run the generated script in Supabase → SQL Editor; it creates a
// login that can only read the schema marketing_intel. Step 3: check.
export default async function AppDatabasePage({ searchParams }: { searchParams: Promise<{ error?: string; connection?: string }> }) {
  const sp = await searchParams;
  const ctx = await getManageContext();
  const cfg = loadConfig();
  let pending: { id: string; ref: string; script: string } | null = null;
  if (sp.connection && /^[0-9a-f-]{36}$/i.test(sp.connection) && cfg.tokenEncryptionKey) {
    const r = (
      await getPool().query<{ id: string; ciphertext: string }>(
        `select c.id, s.ciphertext from public.company_connections c join public.connection_secrets s on s.connection_id = c.id
          where c.id = $1 and c.company_id = $2 and c.provider_id = 'app_database' and c.status = 'pending_authorization'`,
        [sp.connection, ctx.company.id],
      )
    ).rows[0];
    if (r) {
      const secret = decodeSecret(decryptSecret(r.ciphertext, cfg.tokenEncryptionKey, r.id));
      pending = { id: r.id, ref: secret.target.projectRef, script: readerScript(secret.password) };
    }
  }

  return (
    <div className="max-w-3xl space-y-4">
      <a href="/app/connections/new" className="text-sm text-brand-700 hover:underline">← Add a connector</a>
      <h1 className="text-2xl font-semibold">Connect your app&apos;s database</h1>
      <p className="text-sm text-gray-600">
        For apps built on Supabase. The platform gets a login that can <strong>only read</strong> one folder (schema) in your database,{" "}
        <code>marketing_intel</code>, and nothing else. It powers the <strong>Funnel</strong>: where people came from, which steps they took and whether they paid.
      </p>
      {sp.error && <Notice tone="red">{sp.error}</Notice>}

      {!pending ? (
        <Card title="Step 1 of 3 — Your database's address">
          <form action={startAppDbAction} className="space-y-3 text-sm" data-testid="appdb-form">
            <input type="hidden" name="company_id" value={ctx.company.id} />
            <label className="block">
              <span className="font-medium text-gray-800">Connection string</span>
              <textarea
                name="connection_string"
                required
                rows={3}
                placeholder="postgresql://postgres.abcdefghijklmnopqrst:[YOUR-PASSWORD]@aws-0-us-east-1.pooler.supabase.com:5432/postgres"
                className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 font-mono text-xs"
              />
              <span className="mt-1 block text-xs text-gray-500">
                In Supabase open your project → <strong>Connect</strong> (top of the page) → <strong>Session pooler</strong> → copy the string. Leave
                [YOUR-PASSWORD] as it is: the platform never needs your password.
              </span>
            </label>
            <Button>Next</Button>
          </form>
        </Card>
      ) : (
        <>
          <Card title="Step 2 of 3 — Run this script once in Supabase">
            <ol className="mb-3 list-decimal space-y-1 pl-5 text-sm text-gray-700">
              <li>
                Open{" "}
                <a className="font-medium text-brand-700 underline" href={`https://supabase.com/dashboard/project/${pending.ref}/sql/new`} target="_blank" rel="noopener noreferrer">
                  SQL Editor of project {pending.ref}
                </a>
                .
              </li>
              <li>Paste the whole script below and click <strong>Run</strong>.</li>
            </ol>
            <textarea readOnly rows={18} value={pending.script} className="block w-full rounded-lg border border-gray-300 bg-gray-50 p-3 font-mono text-xs" data-testid="appdb-script" />
            <p className="mt-2 text-xs text-gray-500">
              It creates the login <code>mi_reader</code> that can only read <code>marketing_intel</code> (read-only, 20-second limit per query). The password inside is
              the platform&apos;s own and is stored encrypted. To cut access at any time run <code>drop role mi_reader;</code>
            </p>
          </Card>
          <Card title="Step 3 of 3 — Check">
            <form action={checkAppDbAction} className="text-sm">
              <input type="hidden" name="connection_id" value={pending.id} />
              <SubmitButton pendingText="Checking…">Check connection</SubmitButton>
            </form>
          </Card>
        </>
      )}

      <details className="rounded-xl border border-gray-200 bg-white p-5 text-sm" data-testid="appdb-guide">
        <summary className="cursor-pointer font-semibold">What must be inside marketing_intel (for developers)</summary>
        <div className="mt-3 space-y-2 text-gray-700">
          <p>Views with these columns (names matter, order does not). No names or emails are needed — use ids.</p>
          <ul className="list-disc space-y-1 pl-5 font-mono text-xs">
            <li>events(id, at timestamptz, device_id text, person_id uuid, event text, src text, ref_host text, amount numeric, currency text, livemode boolean)</li>
            <li>page_views(id, at timestamptz, device_id text, person_id uuid, path text, ref_host text)</li>
            <li>identities(device_id text, person_id uuid) — which device belongs to which signed-up person</li>
            <li>people(person_id uuid, signed_up_at timestamptz, is_tester boolean)</li>
          </ul>
          <p>
            <code>ref_host</code> is the site the visitor came from (e.g. google.com), <code>src</code> your own campaign label. Purchases: event <code>purchase</code> with{" "}
            <code>amount</code> in normal units (dollars).
          </p>
        </div>
      </details>
    </div>
  );
}
