import { getCompanyContext } from "@/server/appContext";
import { getPool } from "@/server/db";
import { loadConfig } from "@/server/config";
import { decryptSecret } from "@/server/crypto";
import { decodeSecret, type FunnelResult, listAppEvents, loadFunnel } from "@/server/connectors/appDatabase";
import { addDays, localDate } from "@/lib/dates";
import { MAX_STAGES, PAGE_VIEW, sanitizeStages } from "@/lib/funnel";
import { Button, Card, EmptyState, LinkButton, Notice } from "@/components/ui";
import { saveFunnelStagesAction } from "../actions";

export const dynamic = "force-dynamic";

const PERIODS: Record<string, number | null> = { "30": 30, "90": 90, "180": 180, all: null };

// Funnel: people grouped by where they first came from, and how far they got.
// Computed live in the company's own database (read-only); nothing person-level is
// stored by the platform. People are shown by an anonymous label only.
export default async function FunnelPage({ searchParams }: { searchParams: Promise<{ period?: string; testers?: string; error?: string; saved?: string; connected?: string }> }) {
  const sp = await searchParams;
  const ctx = await getCompanyContext();
  const cfg = loadConfig();
  const conn = (
    await getPool().query<{ id: string; ciphertext: string; settings: Record<string, unknown> | null }>(
      `select c.id, s.ciphertext, c.settings from public.company_connections c join public.connection_secrets s on s.connection_id = c.id
        where c.company_id = $1 and c.provider_id = 'app_database' and c.mode = 'live' and c.status in ('connected', 'error')
        order by c.created_at limit 1`,
      [ctx.company.id],
    )
  ).rows[0];

  if (!conn || !cfg.tokenEncryptionKey) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-semibold">Funnel</h1>
        <EmptyState title="See every step from first visit to payment">
          Connect your app&apos;s database once. The platform then shows where people came from, which steps they took and who paid.
          {ctx.access === "manage" && <div className="mt-4"><LinkButton href="/app/connections/app-database">Connect your app&apos;s database</LinkButton></div>}
        </EmptyState>
      </div>
    );
  }

  const tz = ctx.company.timezone;
  const periodKey = sp.period && sp.period in PERIODS ? sp.period : "90";
  const days = PERIODS[periodKey] ?? null;
  const to = localDate(new Date(), tz);
  const from = days === null ? "2000-01-01" : addDays(to, -(days - 1));
  const excludeTesters = sp.testers !== "1";
  const stages = sanitizeStages(conn.settings?.funnel_stages);
  const secret = decodeSecret(decryptSecret(conn.ciphertext, cfg.tokenEncryptionKey, conn.id));
  let result: FunnelResult | null = null;
  let events: string[] = [];
  let problem: string | null = null;
  try {
    const ownHost = ctx.company.website ? new URL(/^https?:/.test(ctx.company.website) ? ctx.company.website : `https://${ctx.company.website}`).hostname : null;
    [result, events] = await Promise.all([
      loadFunnel(secret, { from, to, timezone: tz, stages, excludeTesters, ownHost }),
      ctx.access === "manage" ? listAppEvents(secret) : Promise.resolve([]),
    ]);
  } catch (err) {
    problem = String((err as Error).message ?? "").replace(/^app database: /, "");
  }

  const money = (v: number) => (result?.currency ? new Intl.NumberFormat("en-US", { style: "currency", currency: result.currency, maximumFractionDigits: 0 }).format(v) : v.toFixed(0));
  const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : "—");
  const fmtDay = (iso: string | null) => (iso ? new Intl.DateTimeFormat("en-US", { timeZone: tz, month: "short", day: "numeric" }).format(new Date(iso)) : "");

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Funnel</h1>
          <p className="text-sm text-gray-600">
            People who first came in this period, by where they came from, and how far they got. Live from your app&apos;s database.
          </p>
        </div>
        <form className="flex flex-wrap items-center gap-2 text-sm" data-testid="funnel-filters">
          {Object.keys(PERIODS).map((k) => (
            <button key={k} name="period" value={k} className={`rounded-lg border px-3 py-1.5 ${k === periodKey ? "border-brand-300 bg-brand-50 text-brand-700" : "border-gray-300"}`}>
              {k === "all" ? "All time" : `${k} days`}
            </button>
          ))}
          <label className="ml-2 flex items-center gap-1 text-xs text-gray-600">
            <input type="checkbox" name="testers" value="1" defaultChecked={!excludeTesters} /> include test accounts
          </label>
        </form>
      </div>
      {sp.connected && (
        <Notice tone="green">
          Connected. This is your funnel — change the steps at the bottom of the page if they do not fit. To also see daily sign-ups and purchases on the dashboard,{" "}
          <a className="underline" href={`/app/connections/${conn.id}?setup=1`}>turn on daily updates</a>.
        </Notice>
      )}
      {sp.saved && <Notice tone="green">Steps saved.</Notice>}
      {sp.error && <Notice tone="red">{sp.error}</Notice>}
      {problem && <Notice tone="red">Could not read your app&apos;s database: {problem}</Notice>}

      {result && (
        <>
          <Card title="Steps">
            <ol className="space-y-2" data-testid="funnel-steps">
              {result.stages.map((label, i) => {
                const n = result!.totals[i]!;
                const w = result!.totals[0] ? Math.max(2, Math.round((n / result!.totals[0]!) * 100)) : 0;
                return (
                  <li key={label} className="grid grid-cols-[8rem_1fr_7rem] items-center gap-3 text-sm sm:grid-cols-[10rem_1fr_9rem]">
                    <span className="font-medium text-gray-800">{label}</span>
                    <span className="h-6 rounded bg-gray-100">
                      <span className="block h-6 rounded bg-brand-500" style={{ width: `${w}%` }} />
                    </span>
                    <span className="text-right tabular-nums">
                      <strong>{n.toLocaleString("en-US")}</strong>
                      {i > 0 && <span className="ml-1 text-xs text-gray-500">{pct(n, result!.totals[i - 1]!)} of previous</span>}
                    </span>
                  </li>
                );
              })}
            </ol>
            <p className="mt-3 text-xs text-gray-500">
              Revenue from these people: <strong>{money(result.byChannel.reduce((a, c) => a + c.revenue, 0))}</strong>
              {result.medianDaysToLast !== null && <> · typical time from first visit to “{result.stages.at(-1)}”: <strong>{result.medianDaysToLast} days</strong></>}
              . A step counts only if the earlier steps were reached too.
            </p>
          </Card>

          <FunnelTable title="By channel" rows={result.byChannel.map((r) => ({ name: r.channel, counts: r.counts, revenue: r.revenue }))} stages={result.stages} money={money} pct={pct} />
          <FunnelTable title="By source (first site they came from)" rows={result.bySource.map((r) => ({ name: r.source, sub: r.channel, counts: r.counts, revenue: r.revenue }))} stages={result.stages} money={money} pct={pct} />

          <Card title={`People (${Math.min(result.people.length, 200)} who got furthest)`}>
            <p className="mb-2 text-xs text-gray-500">Anonymous labels — no names or emails leave your database.</p>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs" data-testid="funnel-people">
                <thead className="text-gray-500">
                  <tr>
                    <th className="py-1 pr-3">Person</th>
                    <th className="pr-3">Came from</th>
                    {result.stages.map((s) => <th key={s} className="pr-3">{s}</th>)}
                    <th className="text-right">Paid</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {result.people.map((p) => (
                    <tr key={p.key}>
                      <td className="py-1 pr-3 font-mono">{p.key}</td>
                      <td className="max-w-56 truncate pr-3" title={p.source ?? ""}>{p.channel}{p.source ? ` · ${p.source}` : ""}</td>
                      {p.reached.map((d, i) => <td key={i} className="pr-3 tabular-nums">{d ? fmtDay(d) : <span className="text-gray-300">—</span>}</td>)}
                      <td className="text-right tabular-nums">{p.revenue ? money(p.revenue) : ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </>
      )}

      {ctx.access === "manage" && (
        <details id="stages" className="rounded-xl border border-gray-200 bg-white p-5 text-sm">
          <summary className="cursor-pointer font-semibold">Change the steps</summary>
          <form action={saveFunnelStagesAction} className="mt-3 space-y-2">
            <input type="hidden" name="connection_id" value={conn.id} />
            <p className="text-xs text-gray-500">
              Each step is reached by any of its events (separate with commas). <code>{PAGE_VIEW}</code> = opened any page. Events in your app: {events.slice(0, 60).join(", ") || "—"}
            </p>
            {Array.from({ length: MAX_STAGES }, (_, i) => (
              <div key={i} className="grid grid-cols-[2rem_10rem_1fr] items-center gap-2">
                <span className="text-xs text-gray-500">{i + 1}.</span>
                <input name={`label_${i}`} defaultValue={stages[i]?.label ?? ""} placeholder="Step name" maxLength={40} className="rounded-lg border border-gray-300 px-2 py-1" />
                <input name={`events_${i}`} defaultValue={stages[i]?.events.join(", ") ?? ""} placeholder="event names" className="rounded-lg border border-gray-300 px-2 py-1 font-mono text-xs" list="app-events" />
              </div>
            ))}
            <datalist id="app-events">{[PAGE_VIEW, ...events].map((e) => <option key={e} value={e} />)}</datalist>
            <Button variant="secondary">Save steps</Button>
          </form>
        </details>
      )}
    </div>
  );
}

function FunnelTable({ title, rows, stages, money, pct }: {
  title: string;
  rows: { name: string; sub?: string; counts: number[]; revenue: number }[];
  stages: string[];
  money: (v: number) => string;
  pct: (a: number, b: number) => string;
}) {
  return (
    <Card title={title}>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="text-xs text-gray-500">
            <tr>
              <th className="py-1 pr-3" />
              {stages.map((s) => <th key={s} className="pr-3 text-right">{s}</th>)}
              <th className="pr-3 text-right">Overall</th>
              <th className="text-right">Revenue</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {rows.map((r) => (
              <tr key={r.name}>
                <td className="py-1.5 pr-3">
                  <span className="font-medium text-gray-900">{r.name}</span>
                  {r.sub && <span className="ml-1 text-xs text-gray-500">{r.sub}</span>}
                </td>
                {r.counts.map((n, i) => (
                  <td key={i} className="pr-3 text-right tabular-nums">
                    {n.toLocaleString("en-US")}
                    {i > 0 && <span className="block text-[10px] text-gray-400">{pct(n, r.counts[i - 1]!)}</span>}
                  </td>
                ))}
                <td className="pr-3 text-right tabular-nums">{pct(r.counts.at(-1)!, r.counts[0]!)}</td>
                <td className="text-right tabular-nums">{r.revenue ? money(r.revenue) : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
