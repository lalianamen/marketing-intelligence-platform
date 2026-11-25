import { notFound } from "next/navigation";
import { getCompanyContext } from "@/server/appContext";
import { getPool } from "@/server/db";
import { loadConfig } from "@/server/config";
import { getWarehouse } from "@/server/warehouse";
import { loadConnection, loadRawRows, loadRuns } from "@/server/connections/manage";
import { modeBadge, PROVIDER_LABEL } from "@/server/companyStatus";
import { AutoRefresh } from "@/components/AutoRefresh";
import { ConfirmButton } from "@/components/ConfirmButton";
import { SubmitButton } from "@/components/SubmitButton";
import { Badge, Button, Card, LinkButton, Notice } from "@/components/ui";
import { fmtDateTime, fmtInt } from "@/lib/format";
import { flattenRawPayload, rawColumns } from "@/lib/rawView";
import { deleteConnectionAction, disconnectConnectionAction, syncNowAction, updateScheduleAction } from "../../actions";

const RUN_TONE: Record<string, "green" | "blue" | "red" | "gray"> = { succeeded: "green", running: "blue", queued: "blue", failed: "red", dead: "red", cancelled: "gray" };
const RAW_LIMIT = 500;

export default async function ConnectionPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ saved?: string; error?: string; queued?: string }> }) {
  const { id } = await params;
  const sp = await searchParams;
  const ctx = await getCompanyContext();
  const db = getPool();
  const c = await loadConnection(db, ctx.userId, id);
  if (!c || c.company_id !== ctx.company.id) notFound();
  const tz = ctx.company.timezone;
  const cfg = loadConfig();
  const [runs, raw] = await Promise.all([loadRuns(db, c.id), loadRawRows(db, (p) => getWarehouse(p, cfg), ctx.userId, c.id, RAW_LIMIT)]);
  const flat = raw.rows.map((r) => ({ r, cells: flattenRawPayload(r.origin, r.payload_json) }));
  const cols = rawColumns(flat.map((f) => f.cells));
  const b = modeBadge(c.mode);
  const name = PROVIDER_LABEL[c.provider_id] ?? c.provider_id;
  const canManage = c.access === "manage";
  const busy = runs.some((r) => r.status === "queued" || r.status === "running");

  return (
    <div className="space-y-6">
      <AutoRefresh active={busy} />
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <a href="/app/connections" className="text-sm text-brand-700 hover:underline">← Data Connections</a>
          <h1 className="mt-1 flex items-center gap-2 text-2xl font-semibold">{name} <Badge tone={b.tone}>{b.text}</Badge></h1>
          {c.external_account_name && <p className="text-sm text-gray-600">{c.external_account_name}</p>}
        </div>
        {canManage && (
          <div className="flex flex-wrap items-center gap-2" data-testid="connector-actions">
            {c.mode === "manual" ? (
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
      {sp.saved && <Notice tone="green">Saved.</Notice>}
      {sp.queued && <Notice tone="green">Update requested.</Notice>}

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

        <Card title="Automatic updates" className="lg:col-span-2">
          {c.mode === "manual" || !c.schedule ? (
            <p className="text-sm text-gray-600">CSV files are uploaded by hand, so there is no schedule. Re-uploading replaces numbers for the same day, source and campaign.</p>
          ) : canManage ? (
            <form action={updateScheduleAction} className="space-y-3" data-testid="schedule-form">
              <input type="hidden" name="connection_id" value={c.id} />
              <fieldset className="flex flex-wrap gap-4 text-sm">
                <label className="flex items-center gap-2"><input type="radio" name="frequency" value="daily" defaultChecked={c.schedule.frequency === "daily"} /> Every day at</label>
                <input type="time" name="local_time" defaultValue={c.schedule.local_time} required className="rounded-lg border border-gray-300 px-2 py-1 text-sm" />
                <span className="self-center text-gray-500">{c.schedule.timezone}</span>
              </fieldset>
              <label className="flex items-center gap-2 text-sm"><input type="radio" name="frequency" value="manual" defaultChecked={c.schedule.frequency === "manual"} /> Only when I press “Update now”</label>
              <p className="text-xs text-gray-500">
                {c.schedule.frequency === "daily" && c.schedule.next_run_at ? `Next automatic update: ${fmtDateTime(c.schedule.next_run_at, tz)} (a few minutes of spread are added so not all sources hit Google at once).` : "Automatic updates are off."}
                {" "}Each update re-reads the recent days, because platforms keep adjusting them for a while.
              </p>
              <SubmitButton pendingText="Saving…">Save</SubmitButton>
            </form>
          ) : (
            <p className="text-sm text-gray-600">{c.schedule.frequency === "daily" ? `Every day at ${c.schedule.local_time} (${c.schedule.timezone}).` : "Only manual updates."}</p>
          )}
        </Card>
      </div>

      <Card title="Update history">
        {runs.length === 0 ? <p className="text-sm text-gray-600">No updates yet.</p> : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-xs uppercase text-gray-500"><tr><th className="py-2">When</th><th>Type</th><th>Days</th><th>Rows</th><th>Result</th></tr></thead>
              <tbody className="divide-y divide-gray-100">
                {runs.map((r) => (
                  <tr key={r.id} data-testid="sync-run">
                    <td className="py-2">{fmtDateTime(r.created_at.toISOString(), tz)}</td>
                    <td>{r.trigger.replace("_", " ")}</td>
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

      <Card title="Raw data">
        <p className="mb-3 text-xs text-gray-500">
          Exactly what {name} returned, before any calculation. Newest days first; identical rows from repeated updates are shown once.
          {raw.rows.length >= RAW_LIMIT ? ` Showing the latest ${RAW_LIMIT} rows.` : ""}
        </p>
        {!raw.available ? <p className="text-sm text-gray-600">The company&apos;s data space is not ready yet.</p> : raw.rows.length === 0 ? (
          <p className="text-sm text-gray-600">No raw rows yet. They appear after the first successful update.</p>
        ) : (
          <div className="max-h-[32rem] overflow-auto rounded-lg border border-gray-100">
            <table className="w-full text-left text-xs" data-testid="raw-table">
              <thead className="sticky top-0 bg-gray-50 uppercase text-gray-500">
                <tr><th className="px-2 py-2">Day</th>{cols.map((k) => <th key={k} className="whitespace-nowrap px-2">{k}</th>)}<th className="whitespace-nowrap px-2">Imported</th></tr>
              </thead>
              <tbody className="divide-y divide-gray-100 font-mono">
                {flat.map(({ r, cells }) => (
                  <tr key={r.record_id}>
                    <td className="whitespace-nowrap px-2 py-1.5 font-sans">{r.record_date}</td>
                    {cols.map((k) => <td key={k} className="whitespace-nowrap px-2">{cells[k] ?? ""}</td>)}
                    <td className="whitespace-nowrap px-2 font-sans text-gray-500">{fmtDateTime(r.ingested_at, tz)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
