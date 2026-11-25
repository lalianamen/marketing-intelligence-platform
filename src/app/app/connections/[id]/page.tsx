import { notFound } from "next/navigation";
import { getCompanyContext } from "@/server/appContext";
import { getPool } from "@/server/db";
import { loadConfig } from "@/server/config";
import { getWarehouse } from "@/server/warehouse";
import { loadConnection, loadRawPage, loadRuns } from "@/server/connections/manage";
import { modeBadge, PROVIDER_LABEL } from "@/server/companyStatus";
import { AutoRefresh } from "@/components/AutoRefresh";
import { LoadStatus } from "@/components/LoadStatus";
import { queuePositions } from "@/server/jobs/queue";
import { ConfirmButton } from "@/components/ConfirmButton";
import { SubmitButton } from "@/components/SubmitButton";
import { ScheduleForm } from "@/components/ScheduleForm";
import { Badge, Button, Card, LinkButton, Notice } from "@/components/ui";
import { fmtDateTime, fmtInt } from "@/lib/format";
import { displayValue, parseRawTableParams, rawTableQuery, valueAt } from "@/lib/rawTable";
import { RawFilterRow } from "@/components/RawFilterRow";
import { ScrollX } from "@/components/ScrollX";
import { Expandable } from "@/components/Expandable";
import { GA4_GROUPS, GA4_MAX_DIMENSIONS, GA4_MAX_METRICS, ga4Fields, sanitizeGa4Groups } from "@/lib/ga4Catalog";
import { Ga4GroupPicker } from "@/components/Ga4GroupPicker";
import { deleteConnectionAction, disconnectConnectionAction, requestHistoryAction, startLoadingAction, syncNowAction, saveGa4GroupsAction, updateScheduleAction } from "../../actions";
import { addDays, localDate } from "@/lib/dates";

const RUN_TONE: Record<string, "green" | "blue" | "red" | "gray"> = { succeeded: "green", running: "blue", queued: "blue", failed: "red", dead: "red", cancelled: "gray" };
const PAGE_SIZE = 100;

export default async function ConnectionPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const { id } = await params;
  const sp = await searchParams;
  const ctx = await getCompanyContext();
  const db = getPool();
  const c = await loadConnection(db, ctx.userId, id);
  if (!c || c.company_id !== ctx.company.id) notFound();
  const tz = ctx.company.timezone;
  const cfg = loadConfig();
  const isGa4Live = c.provider_id === "ga4" && c.mode === "live";
  const inSetup = c.mode !== "manual" && !c.activated_at;
  const enabledReports = isGa4Live ? sanitizeGa4Groups(c.settings?.ga4_reports) : [];
  const fieldsNow = ga4Fields(enabledReports);
  // GA4 rows of the one table have source "ga4" (rows of the former separate reports are not shown).
  const rawSource = c.provider_id === "ga4" ? "ga4" : undefined;
  const tableYesterday = addDays(localDate(new Date(), tz), -1);
  const tp = parseRawTableParams(sp, tableYesterday);
  const [runs, raw] = await Promise.all([
    loadRuns(db, c.id),
    loadRawPage(db, (p) => getWarehouse(p, cfg), ctx.userId, c.id, tp, { source: rawSource, limit: PAGE_SIZE, offset: (tp.page - 1) * PAGE_SIZE }),
  ]);
  const cols = raw.columns;
  const parsed = raw.rows.map((r) => {
    let payload: unknown = {};
    try {
      payload = JSON.parse(r.payload_json);
    } catch {
      payload = {};
    }
    return { r, payload };
  });
  const baseQ: Record<string, string> = {};
  const href = (change: Parameters<typeof rawTableQuery>[2]) => `/app/connections/${c.id}?${rawTableQuery(baseQ, tp, { page: 1, ...change })}#raw`;
  const exportHref = (full: boolean) => `/app/connections/${c.id}/export?${rawTableQuery({ ...baseQ, ...(full ? { full: "1" } : {}) }, tp, { page: 1 })}`;
  const pages = Math.max(1, Math.ceil(raw.total / PAGE_SIZE));
  const sortLink = (key: string) => href({ sort: key, dir: tp.sort === key && tp.dir === "desc" ? "asc" : "desc" });
  const sortMark = (key: string) => (tp.sort === key ? (tp.dir === "desc" ? " ↓" : " ↑") : "");
  const b = modeBadge(c.mode);
  const name = PROVIDER_LABEL[c.provider_id] ?? c.provider_id;
  const canManage = c.access === "manage";
  const busy = runs.some((r) => r.status === "queued" || r.status === "running");
  const current = runs.find((r) => r.status !== "cancelled");
  const position = current?.status === "queued" ? (await queuePositions(db, [current.id])).get(current.id) : undefined;
  const yesterday = addDays(localDate(new Date(), tz), -1);
  const historyRunning = runs.some((r) => r.trigger === "backfill" && (r.status === "queued" || r.status === "running"));

  return (
    <div className="space-y-6">
      <AutoRefresh active={busy} />
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <a href="/app/connections" className="text-sm text-brand-700 hover:underline">← Data Connections</a>
          <h1 className="mt-1 flex flex-wrap items-center gap-2 text-2xl font-semibold">{name} <Badge tone={b.tone}>{b.text}</Badge> {inSetup ? <Badge tone="amber">Needs setup</Badge> : <LoadStatus run={current} position={position} tz={tz} />}</h1>
          {c.external_account_name && <p className="text-sm text-gray-600">{c.external_account_name}</p>}
        </div>
        {canManage && (
          <div className="flex flex-wrap items-center gap-2" data-testid="connector-actions">
            {inSetup ? null : c.mode === "manual" ? (
              <LinkButton href="/app/connections/csv">Upload new file</LinkButton>
            ) : (
              <form action={syncNowAction}>
                <input type="hidden" name="connection_id" value={c.id} />
                <input type="hidden" name="back" value={`/app/connections/${c.id}`} />
                <Button>Update now</Button>
              </form>
            )}
            {c.mode !== "manual" && (
              <ConfirmButton
                action={disconnectConnectionAction}
                fields={{ connection_id: c.id }}
                label="Disconnect"
                danger={false}
                title={`Disconnect ${name}?`}
                lines={["Automatic updates stop and the stored sign-in is removed.", "Data already imported stays on the dashboard."]}
                confirmLabel="Disconnect"
                pendingLabel="Disconnecting…"
              />
            )}
            <ConfirmButton
              action={deleteConnectionAction}
              fields={{ connection_id: c.id }}
              label="Delete"
              title={`Delete ${name}${c.external_account_name ? ` (${c.external_account_name})` : ""}?`}
              lines={[
                "The connector and all data it imported will be permanently deleted from the database.",
                "Dashboard and analytics numbers from this source disappear. Other sources are not affected.",
                "This cannot be undone.",
              ]}
              confirmLabel="Delete connector and its data"
              pendingLabel="Deleting…"
            />
          </div>
        )}
      </div>
      {sp.error && <Notice tone="red">{sp.error}</Notice>}
      {sp.queued && <Notice tone="green">Update requested.</Notice>}
      {sp.restarted && <Notice tone="green">All data of this connector was deleted and loading started again with the new columns for the last 30 days ({sp.rfrom} → {sp.rto}).</Notice>}
      {sp.started && <Notice tone="green">Loading started in {sp.started} part{sp.started === "1" ? "" : "s"} of up to one month. Automatic updates are on as chosen.</Notice>}

      {inSetup && (
        <section id="setup" className="space-y-4 rounded-xl border-2 border-brand-200 bg-white p-5" data-testid="connector-setup">
          <div>
            <h2 className="text-lg font-semibold">Set up before the first load</h2>
            <p className="text-sm text-gray-600">Nothing has been loaded yet. Choose what to collect, for which period and how often, then press Start loading.</p>
          </div>
          <Notice tone="amber">
            Switch on all the data you need <strong>now</strong>, before the first load. If you change the data later, all data of
            this connector is deleted and only the last 30 days are loaded again — and a new load takes time.
          </Notice>
          <ol className="space-y-1 text-sm text-gray-700">
            <li><strong>1. What to collect</strong> — {isGa4Live ? "switch groups on in the list below; their columns are added to the one table (the dashboard columns are always included)." : "this source has one standard table."}</li>
            <li><strong>2. Period</strong> and <strong>3. Schedule</strong> — in the form below.</li>
          </ol>
        </section>
      )}

      {isGa4Live && (
        <details id="ga4-reports" className="rounded-xl border border-gray-200 bg-white p-5" data-testid="ga4-catalog" open={inSetup || Boolean(sp.groups_saved || sp.groups_unchanged || sp.error)}>
          <summary className="cursor-pointer text-base font-semibold">Data in the table <span className="ml-2 text-sm font-normal text-gray-500">{fieldsNow.dimensions.length} of {GA4_MAX_DIMENSIONS} breakdowns · {fieldsNow.metrics.length} of {GA4_MAX_METRICS} numbers</span></summary>
          <p className="mt-2 text-xs text-gray-500">
            {inSetup
              ? "Switch on everything you want in the table before the first load. Each group adds its columns to the same table."
              : "Each group adds its columns to the one table. Choose everything first, then press Save: only then all data of this connector is deleted and the last 30 days are loaded again."}
            {" "}GA4 allows at most {GA4_MAX_DIMENSIONS} breakdowns and {GA4_MAX_METRICS} numbers in one table.
          </p>
          {sp.groups_saved && <div className="mt-3"><Notice tone="green">Saved. These columns will be in the table from the first load.</Notice></div>}
          {sp.groups_unchanged && <div className="mt-3"><Notice tone="blue">Nothing changed, so nothing was deleted or reloaded.</Notice></div>}
          <Ga4GroupPicker
            key={enabledReports.join(",")}
            action={saveGa4GroupsAction}
            connectionId={c.id}
            groups={GA4_GROUPS}
            saved={enabledReports}
            canManage={canManage}
            reloadOnSave={!inSetup}
          />
        </details>
      )}

      {inSetup && canManage && (
        <Card title="Period and schedule">
          <form action={startLoadingAction} className="space-y-4 text-sm" data-testid="start-loading-form">
            <input type="hidden" name="connection_id" value={c.id} />
            <fieldset className="space-y-2">
              <legend className="font-medium text-gray-800">2. Period to load</legend>
              <div className="flex flex-wrap items-end gap-3">
                <label className="block">
                  <span className="text-gray-700">From</span>
                  <input type="date" name="from" required min={addDays(yesterday, -399)} max={yesterday} defaultValue={addDays(yesterday, -29)} className="mt-1 block rounded-lg border border-gray-300 px-2 py-1" />
                </label>
                <label className="block">
                  <span className="text-gray-700">To</span>
                  <input type="date" name="to" required min={addDays(yesterday, -399)} max={yesterday} defaultValue={yesterday} className="mt-1 block rounded-lg border border-gray-300 px-2 py-1" />
                </label>
                <span className="text-xs text-gray-500">Default: the last 30 complete days. Up to 400 days back, loaded in parts of up to one month.</span>
              </div>
            </fieldset>
            <fieldset className="space-y-2">
              <legend className="font-medium text-gray-800">3. Automatic updates</legend>
              <div className="flex flex-wrap items-center gap-3">
                <label className="flex items-center gap-2"><input type="radio" name="frequency" value="daily" defaultChecked /> Every day at</label>
                <input type="time" name="local_time" defaultValue={c.schedule?.local_time ?? "06:00"} required className="rounded-lg border border-gray-300 px-2 py-1" />
                <span className="text-gray-500">{tz}</span>
              </div>
              <label className="flex items-center gap-2"><input type="radio" name="frequency" value="manual" /> Only when I press “Update now”</label>
            </fieldset>
            <SubmitButton pendingText="Starting…">Start loading</SubmitButton>
          </form>
        </Card>
      )}

      {!inSetup && (
        <>
      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Status">
          <dl className="space-y-1.5 text-sm">
            <div className="flex justify-between gap-2"><dt className="text-gray-500">Status</dt><dd><Badge tone={c.status === "connected" ? "green" : c.status === "expired" || c.status === "error" ? "red" : "gray"}>{c.status === "expired" ? "Needs reconnecting" : c.status}</Badge></dd></div>
            <div className="flex justify-between gap-2"><dt className="text-gray-500">Last update</dt><dd>{fmtDateTime(c.last_synced_at, tz)}</dd></div>
            <div className="flex justify-between gap-2"><dt className="text-gray-500">Data up to</dt><dd>{c.data_as_of ?? "—"}</dd></div>
            {c.external_account_id && <div className="flex justify-between gap-2"><dt className="text-gray-500">{c.provider_id === "ga4" ? "Property ID" : "Account ID"}</dt><dd className="font-mono">{c.external_account_id}</dd></div>}
            <div className="flex justify-between gap-2"><dt className="text-gray-500">Connected</dt><dd>{fmtDateTime(c.created_at, tz)}</dd></div>
          </dl>
          {c.last_error && <p className="mt-2 text-xs text-red-700">{c.last_error}</p>}
          {c.status === "expired" && canManage && <div className="mt-3"><LinkButton href="/app/connections/new">Reconnect</LinkButton></div>}
        </Card>

        <div id="schedule" className="lg:col-span-2">
        <Card title="Automatic updates">
          {c.mode === "manual" || !c.schedule ? (
            <p className="text-sm text-gray-600">CSV files are uploaded by hand, so there is no schedule. Re-uploading replaces numbers for the same day, source and campaign.</p>
          ) : canManage ? (
            <ScheduleForm
              key={`${c.schedule.frequency}-${c.schedule.local_time}`}
              action={updateScheduleAction}
              connectionId={c.id}
              saved={{ frequency: c.schedule.frequency, localTime: c.schedule.local_time }}
              timezone={c.schedule.timezone}
              justSaved={Boolean(sp.saved)}
              nextRunText={
                c.schedule.frequency === "daily" && c.schedule.next_run_at
                  ? new Date(c.schedule.next_run_at).getTime() <= Date.now()
                    ? "Next update: due now — it starts within a minute or two."
                    : `Next update: about ${fmtDateTime(c.schedule.next_run_at, tz)}.`
                  : "Automatic updates are off."
              }
            />
          ) : (
            <p className="text-sm text-gray-600">{c.schedule.frequency === "daily" ? `Every day at ${c.schedule.local_time} (${c.schedule.timezone}).` : "Only manual updates."}</p>
          )}
        </Card>
        </div>
      </div>

      {canManage && c.mode !== "manual" && (
        <Card title="Load history">
          <div id="history" />
          {sp.history && <div className="mb-3"><Notice tone="green">History load queued in {sp.history} part{sp.history === "1" ? "" : "s"} of up to one month. Parts load one after another; progress shows in Update history.</Notice></div>}
          <p className="text-sm text-gray-600">
            Load past days, for example before the connector was added. To stay reliable, a period is loaded in parts of up to one month each; if one part fails, only that part is retried. The first connection always loads the last 30 days.
          </p>
          <form action={requestHistoryAction} className="mt-3 flex flex-wrap items-end gap-3 text-sm" data-testid="history-form">
            <input type="hidden" name="connection_id" value={c.id} />
            <label className="block">
              <span className="text-gray-700">From</span>
              <input type="date" name="from" required min={addDays(yesterday, -399)} max={yesterday} defaultValue={addDays(yesterday, -89)} className="mt-1 block rounded-lg border border-gray-300 px-2 py-1" />
            </label>
            <label className="block">
              <span className="text-gray-700">To</span>
              <input type="date" name="to" required min={addDays(yesterday, -399)} max={yesterday} defaultValue={yesterday} className="mt-1 block rounded-lg border border-gray-300 px-2 py-1" />
            </label>
            <SubmitButton pendingText="Queuing…">{historyRunning ? "Loading…" : "Load history"}</SubmitButton>
            <span className="text-xs text-gray-500">Up to 400 days back. Days already loaded are replaced, never duplicated.</span>
          </form>
        </Card>
      )}

      <Card title="Update history">
        {runs.length === 0 ? <p className="text-sm text-gray-600">No updates yet.</p> : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-xs uppercase text-gray-500"><tr><th className="py-2">When</th><th>Type</th><th>Days</th><th>Rows</th><th>Result</th></tr></thead>
              <tbody className="divide-y divide-gray-100">
                {runs.map((r) => (
                  <tr key={r.id} data-testid="sync-run">
                    <td className="py-2">{fmtDateTime(r.created_at.toISOString(), tz)}</td>
                    <td>{r.trigger === "backfill" ? "history" : r.trigger.replace("_", " ")}</td>
                    <td>{r.window_start ? `${r.window_start} → ${r.window_end}` : "—"}</td>
                    <td>{fmtInt(r.rows_written)}</td>
                    <td><Badge tone={RUN_TONE[r.status] ?? "gray"}>{r.status}</Badge>{r.error_code && r.status !== "succeeded" && <span className="ml-1 text-xs text-red-700">{r.error_code}</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
        </>
      )}

      {!inSetup && (
      <Card title="Raw data">
        <p id="raw" className="mb-3 text-xs text-gray-500">
          Exactly what {name} returned, before any calculation. One row per day and value; repeated updates replace rows, never duplicate them.
        </p>
        <Expandable title={`${name} — raw data`}>
        <form method="get" action={`/app/connections/${c.id}#raw`} className="mb-3 space-y-2 rounded-lg border border-gray-100 bg-gray-50 p-3 text-xs" data-testid="raw-filters">
          {Object.entries(baseQ).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
          {tp.sort !== "day" && <input type="hidden" name="sort" value={tp.sort} />}
          {tp.dir !== "desc" && <input type="hidden" name="dir" value={tp.dir} />}
          <div className="flex flex-wrap items-end gap-2">
            <span className="font-medium text-gray-700">Period</span>
            {[["7", "7 days"], ["30", "30 days"], ["90", "90 days"], ["all", "All"]].map(([v, l]) => (
              <a key={v} href={href({ preset: v!, from: null, to: null })} className={`rounded-md px-2 py-1 ring-1 ${tp.preset === v ? "bg-brand-50 text-brand-700 ring-brand-200" : "bg-white text-gray-700 ring-gray-200"}`}>{l}</a>
            ))}
            <label className="flex items-center gap-1">from <input type="date" name="from" defaultValue={tp.from ?? ""} className="rounded border border-gray-300 px-1.5 py-1" /></label>
            <label className="flex items-center gap-1">to <input type="date" name="to" defaultValue={tp.to ?? ""} className="rounded border border-gray-300 px-1.5 py-1" /></label>
            <input type="hidden" name="period" value="custom" />
          </div>
          {[1, 2, 3].map((n) => (
            <RawFilterRow
              key={`${n}-${sp[`f${n}c`] ?? ""}`}
              n={n}
              columns={cols.map((col) => col.label)}
              valuesUrl={`/app/connections/${c.id}/values`}
              initial={{ col: sp[`f${n}c`] ?? "", op: sp[`f${n}o`] ?? "eq", value: sp[`f${n}v`] ?? "" }}
              initialValues={raw.suggestions[sp[`f${n}c`] ?? ""] ?? []}
            />
          ))}
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <button className="rounded-md bg-brand-600 px-3 py-1.5 font-medium text-white">Apply</button>
            <a href={`/app/connections/${c.id}?${new URLSearchParams(baseQ).toString()}#raw`} className="rounded-md px-3 py-1.5 text-gray-700 ring-1 ring-gray-300">Reset</a>
            <span className="ml-auto flex flex-wrap gap-2">
              <a href={exportHref(false)} className="rounded-md bg-white px-3 py-1.5 font-medium text-gray-800 ring-1 ring-gray-300" data-testid="export-view">Export this view (CSV)</a>
              <a href={exportHref(true)} className="rounded-md bg-white px-3 py-1.5 font-medium text-gray-800 ring-1 ring-gray-300" data-testid="export-all">Export full period (CSV)</a>
            </span>
          </div>
        </form>
        {!raw.available ? <p className="text-sm text-gray-600">The company&apos;s data space is not ready yet.</p> : raw.total === 0 ? (
          <p className="text-sm text-gray-600">No rows for this period and filters.</p>
        ) : (
          <>
            <p className="mb-2 text-xs text-gray-600" data-testid="raw-total">{raw.total.toLocaleString("en-US")} rows · page {tp.page} of {pages}{tp.from || tp.to ? ` · ${tp.from ?? "…"} → ${tp.to ?? "…"}` : " · all days"}</p>
            <ScrollX className="raw-scroll max-h-[32rem] rounded-lg border border-gray-100">
              <table className="w-full text-left text-xs" data-testid="raw-table">
                <thead className="sticky top-0 bg-gray-50 uppercase text-gray-500">
                  <tr>
                    <th className="px-2 py-2"><a href={sortLink("day")} className="hover:text-gray-900">Day{sortMark("day")}</a></th>
                    {cols.map((col) => <th key={col.label} className="whitespace-nowrap px-2"><a href={sortLink(col.label)} className="hover:text-gray-900">{col.label}{sortMark(col.label)}</a></th>)}
                    <th className="whitespace-nowrap px-2 pr-6"><a href={sortLink("imported")} className="hover:text-gray-900">Imported{sortMark("imported")}</a></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 font-mono">
                  {parsed.map(({ r, payload }) => (
                    <tr key={r.record_id}>
                      <td className="whitespace-nowrap px-2 py-1.5 font-sans">{r.record_date}</td>
                      {cols.map((col) => { const v = valueAt(payload, col.path); const shown = displayValue(col.label, v); return <td key={col.label} className="whitespace-nowrap px-2" title={shown !== v ? v : undefined}>{shown}</td>; })}
                      <td className="whitespace-nowrap px-2 pr-6 font-sans text-gray-500">{fmtDateTime(r.ingested_at, tz)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </ScrollX>
            {pages > 1 && (
              <div className="mt-2 flex items-center gap-2 text-xs">
                {tp.page > 1 && <a href={href({ page: tp.page - 1 })} className="rounded-md px-2 py-1 ring-1 ring-gray-300">← Previous</a>}
                {tp.page < pages && <a href={href({ page: tp.page + 1 })} className="rounded-md px-2 py-1 ring-1 ring-gray-300">Next →</a>}
              </div>
            )}
          </>
        )}
        </Expandable>
      </Card>
      )}
    </div>
  );
}
