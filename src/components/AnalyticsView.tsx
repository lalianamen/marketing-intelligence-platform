import type { PeriodSummary } from "@/lib/kpi";
import { percentChange } from "@/lib/kpi";
import type { CampaignRow } from "@/lib/model";
import { CONVERSION_TYPE_LABEL, ORIGIN_LABEL } from "@/lib/model";
import { fmtInt, fmtMoney, fmtNumber, kpiReason, kpiText } from "@/lib/format";
import { KpiCard } from "./Kpi";
import { BarList, LineChart } from "./Charts";
import { Badge, SimulatedBanner } from "./ui";

export function sourceLabel(origin: string, source: string): string {
  if (origin === "csv") return `${source.replace(/_/g, " ")} (CSV)`;
  return ORIGIN_LABEL[origin as keyof typeof ORIGIN_LABEL] ?? source;
}

/** Overview cards. Money cards only when the period has one currency. */
export function OverviewCards({ current, previous }: { current: PeriodSummary; previous: PeriodSummary | null }) {
  const cur = current.blended;
  const prev = previous?.blended;
  const single = current.currencies.length === 1 ? current.currencies[0]! : null;
  const spendCur = single ? cur.totals.spendByCurrency[single]! : null;
  const spendPrev = single && prev ? (prev.totals.spendByCurrency[single] ?? null) : null;
  return (
    <div className="space-y-2">
    {current.blendedScope === "real" && current.hasSimulated && (
      <p className="text-xs text-gray-600" data-testid="blend-note">Summary cards and daily charts include <strong>only your real data</strong>. Sample (SIMULATED) sources are shown separately in the tables below.</p>
    )}
    {current.blendedScope === "simulated" && (
      <p className="text-xs font-medium text-amber-900" data-testid="blend-note">Summary cards below are built from SAMPLE data only.</p>
    )}
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
      <KpiCard testId="kpi-spend" label="Ad spend" value={single ? fmtMoney(spendCur, single) : current.currencies.length > 1 ? Object.entries(cur.totals.spendByCurrency).map(([c, v]) => fmtMoney(v, c)).join(" + ") : "Not available"} delta={single ? percentChange(spendCur, spendPrev) : undefined} hint={current.currencies.length > 1 ? "Several currencies; not converted." : undefined} />
      <KpiCard testId="kpi-impressions" label="Impressions" value={cur.totals.impressions === null ? "Not available" : fmtInt(cur.totals.impressions)} delta={percentChange(cur.totals.impressions, prev?.totals.impressions ?? null)} />
      <KpiCard testId="kpi-clicks" label="Clicks" value={cur.totals.clicks === null ? "Not available" : fmtInt(cur.totals.clicks)} delta={percentChange(cur.totals.clicks, prev?.totals.clicks ?? null)} />
      <KpiCard testId="kpi-sessions" label="Website sessions" value={cur.totals.sessions === null ? "Not available" : fmtInt(cur.totals.sessions)} delta={percentChange(cur.totals.sessions, prev?.totals.sessions ?? null)} />
      <KpiCard testId="kpi-ctr" label="CTR (click-through rate)" value={kpiText(cur.kpis.ctr, "percent")} delta={percentChange(cur.kpis.ctr.value, prev?.kpis.ctr.value ?? null)} hint={kpiReason(cur.kpis.ctr) ?? "Clicks ÷ impressions"} />
      <KpiCard testId="kpi-cpc" label="CPC (cost per click)" value={kpiText(cur.kpis.cpc, "money", single)} delta={percentChange(cur.kpis.cpc.value, prev?.kpis.cpc.value ?? null)} hint={kpiReason(cur.kpis.cpc) ?? "Spend ÷ clicks"} />
      <KpiCard testId="kpi-cpm" label="CPM (cost per 1,000 views)" value={kpiText(cur.kpis.cpm, "money", single)} delta={percentChange(cur.kpis.cpm.value, prev?.kpis.cpm.value ?? null)} hint={kpiReason(cur.kpis.cpm) ?? "Spend ÷ impressions × 1,000"} />
      <KpiCard label="Sources with data" value={String(current.bySource.length)} hint="Conversions and leads are shown per source below." />
    </div>
    </div>
  );
}

export function AnalyticsView({ current, previous, campaigns }: { current: PeriodSummary; previous: PeriodSummary | null; campaigns: CampaignRow[] }) {
  const single = current.currencies.length === 1 ? current.currencies[0]! : null;
  return (
    <div className="space-y-6">
      {current.hasSimulated && <SimulatedBanner what="Some sources in this period use sample data (marked SIMULATED)." />}
      {current.hasPreliminary && <p className="text-xs text-gray-500">Recent days are <strong>preliminary</strong>: platforms can still update them (for example late conversions). They are refreshed automatically.</p>}
      <OverviewCards current={current} previous={previous} />
      <div className="grid gap-4 lg:grid-cols-2">
        {single && <LineChart title={`Ad spend per day (${single})`} points={current.daily.map((d) => ({ x: d.date, y: d.spend }))} format={(n) => fmtMoney(n, single)} />}
        <LineChart title="Clicks per day" points={current.daily.map((d) => ({ x: d.date, y: d.clicks }))} format={(n) => fmtInt(n)} />
        <LineChart title="Website sessions per day" points={current.daily.map((d) => ({ x: d.date, y: d.sessions }))} format={(n) => fmtInt(n)} />
        {single && (
          <BarList
            title={`Spend by source (${single})`}
            items={current.bySource.filter((s) => s.totals.spendByCurrency[single]).map((s) => ({ label: sourceLabel(s.origin, s.source), value: s.totals.spendByCurrency[single]!, note: s.isSimulated ? "simulated" : undefined }))}
            format={(n) => fmtMoney(n, single)}
          />
        )}
      </div>

      <section className="rounded-xl border border-gray-200 bg-white p-4">
        <h2 className="mb-1 text-base font-semibold">By source</h2>
        <p className="mb-3 text-xs text-gray-500">Each source counts conversions its own way, so conversions are never added together across sources.</p>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm" data-testid="source-table">
            <thead className="text-xs uppercase text-gray-500">
              <tr><th className="py-2">Source</th><th>Spend</th><th>Impr.</th><th>Clicks</th><th>CTR</th><th>CPC</th><th>Sessions</th><th>Conversions</th><th>Conv. rate</th><th>Leads</th><th>CPL</th><th>Revenue</th><th>ROAS</th></tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {current.bySource.map((s) => {
                const cur = Object.keys(s.totals.spendByCurrency)[0] ?? Object.keys(s.totals.attributedRevenueByCurrency)[0] ?? null;
                const money = (m: Record<string, number>) => Object.entries(m).map(([c, v]) => fmtMoney(v, c)).join(" + ") || "—";
                return (
                  <tr key={s.key}>
                    <td className="py-2 font-medium">{sourceLabel(s.origin, s.source)} {s.isSimulated && <Badge tone="amber">SIMULATED</Badge>}</td>
                    <td>{money(s.totals.spendByCurrency)}</td>
                    <td>{fmtInt(s.totals.impressions)}</td>
                    <td>{fmtInt(s.totals.clicks)}</td>
                    <td title={kpiReason(s.kpis.ctr)}>{s.kpis.ctr.status === "ok" ? `${s.kpis.ctr.value!.toFixed(2)}%` : "—"}</td>
                    <td title={kpiReason(s.kpis.cpc)}>{s.kpis.cpc.status === "ok" ? fmtMoney(s.kpis.cpc.value, cur) : "—"}</td>
                    <td>{fmtInt(s.totals.sessions)}</td>
                    <td>{s.totals.conversions === null ? "—" : <>{fmtNumber(s.totals.conversions)} <span className="block text-xs text-gray-500">{s.conversionType && s.conversionType !== "mixed" ? CONVERSION_TYPE_LABEL[s.conversionType] : s.conversionType === "mixed" ? "mixed definitions" : ""}</span></>}</td>
                    <td title={kpiReason(s.kpis.conversion_rate)}>{s.kpis.conversion_rate.status === "ok" ? `${s.kpis.conversion_rate.value!.toFixed(2)}%` : "—"}</td>
                    <td>{fmtInt(s.totals.leads)}</td>
                    <td title={kpiReason(s.kpis.cpl)}>{s.kpis.cpl.status === "ok" ? fmtMoney(s.kpis.cpl.value, cur) : "—"}</td>
                    <td>
                      {Object.keys(s.totals.attributedRevenueByCurrency).length ? <span title="Reported by the platform (attributed), not verified billing">{money(s.totals.attributedRevenueByCurrency)} <span className="text-xs text-gray-500">attributed</span></span> : null}
                      {Object.keys(s.totals.billedRevenueByCurrency).length ? <span>{money(s.totals.billedRevenueByCurrency)} <span className="text-xs text-gray-500">billed</span></span> : null}
                      {!Object.keys(s.totals.attributedRevenueByCurrency).length && !Object.keys(s.totals.billedRevenueByCurrency).length ? "—" : null}
                    </td>
                    <td title={kpiReason(s.kpis.roas) ?? "Attributed revenue ÷ spend, as reported by this source"}>{s.kpis.roas.status === "ok" ? `${s.kpis.roas.value!.toFixed(2)}×` : "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-xs text-gray-500">— = not available from this source for this period. CAC and ROI need customer and profit data, which Phase 1 does not collect.</p>
      </section>

      <section className="rounded-xl border border-gray-200 bg-white p-4">
        <h2 className="mb-3 text-base font-semibold">Campaigns</h2>
        {campaigns.length === 0 ? <p className="text-sm text-gray-600">No campaign rows in this period.</p> : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm" data-testid="campaign-table">
              <thead className="text-xs uppercase text-gray-500"><tr><th className="py-2">Campaign</th><th>Source</th><th>Spend</th><th>Impr.</th><th>Clicks</th><th>Sessions</th><th>Conversions</th><th>Leads</th></tr></thead>
              <tbody className="divide-y divide-gray-100">
                {campaigns.slice(0, 100).map((c) => (
                  <tr key={`${c.origin}|${c.source}|${c.account_id}|${c.campaign_id}|${c.currency}`}>
                    <td className="py-2">{c.campaign_name ?? c.campaign_id}{c.is_simulated && <> <Badge tone="amber">SIMULATED</Badge></>}</td>
                    <td>{sourceLabel(c.origin, c.source)}</td>
                    <td>{fmtMoney(c.spend, c.currency)}</td>
                    <td>{fmtInt(c.impressions)}</td>
                    <td>{fmtInt(c.clicks)}</td>
                    <td>{fmtInt(c.sessions)}</td>
                    <td>{c.conversions === null ? "—" : fmtNumber(c.conversions)}</td>
                    <td>{fmtInt(c.leads)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
