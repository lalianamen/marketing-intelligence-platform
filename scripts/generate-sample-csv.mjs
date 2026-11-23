// Generates public/sample-marketing-data.csv: SYNTHETIC demo data (not real
// business results). Deterministic so the file is reproducible.
import { writeFileSync } from "node:fs";

let seed = 42;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const header = "date,source,account_id,account_name,campaign_id,campaign_name,currency,spend,impressions,clicks,sessions,conversions,leads,revenue,revenue_type";
const rows = [header];
const start = Date.UTC(2026, 9, 1); // 2026-10-01
for (let i = 0; i < 31; i++) {
  const date = new Date(start + i * 86400000).toISOString().slice(0, 10);
  for (const [cid, name, scale] of [["m-101", "Synthetic - AC Repair Leads", 1], ["m-102", "Synthetic - Heating Tune-up", 0.6]]) {
    const imp = Math.round((3000 + rnd() * 2000) * scale);
    const clk = Math.round(imp * (0.012 + rnd() * 0.01));
    const spend = (clk * (0.8 + rnd() * 0.9)).toFixed(2);
    const conv = Math.round(clk * (0.05 + rnd() * 0.05));
    rows.push(`${date},meta_ads,demo-meta,Demo Meta account,${cid},${name},USD,${spend},${imp},${clk},,${conv},${conv},,`);
  }
  {
    const imp = Math.round(900 + rnd() * 600);
    const clk = Math.round(imp * (0.03 + rnd() * 0.02));
    const spend = (clk * (1.5 + rnd())).toFixed(2);
    const conv = Math.round(clk * (0.06 + rnd() * 0.04));
    rows.push(`${date},bing_ads,demo-bing,Demo Microsoft Ads account,b-201,Synthetic - Emergency HVAC,USD,${spend},${imp},${clk},,${conv},,,`);
  }
  rows.push(`${date},newsletter,,,,Synthetic - Monthly newsletter,,,,,${Math.round(40 + rnd() * 30)},,${Math.round(rnd() * 3)},,`);
  if (i % 3 === 0) rows.push(`${date},crm,,,,(none),USD,,,,,,,${(400 + rnd() * 900).toFixed(2)},billed`);
}
writeFileSync("public/sample-marketing-data.csv", rows.join("\n") + "\n");
console.log(`wrote ${rows.length - 1} synthetic rows`);
