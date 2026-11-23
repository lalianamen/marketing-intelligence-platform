// End-to-end test of the main user journey against the LOCAL stack:
// sign up → confirm email (Mailpit) → workspace → add company → data space ready
// → upload CSV → preview → import → KPIs → export CSV → sample connector labelled SIMULATED.
// Requires: `npm run db:start`, `npm run env:local`, `npm run build`.
// Starts `next start` and the worker itself. Screenshots go to test-results/.
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
// Uses the pre-installed Playwright (or a locally installed one).
const { chromium } = createRequire(import.meta.url)("playwright");

const BASE = "http://127.0.0.1:3000";
const MAILPIT = process.env.MAILPIT_URL ?? "http://127.0.0.1:54324";
const OUT = "test-results";
mkdirSync(OUT, { recursive: true });

function start(cmd, args, name) {
  const p = spawn(cmd, args, { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
  p.stdout.on("data", (d) => process.env.E2E_VERBOSE && process.stdout.write(`[${name}] ${d}`));
  p.stderr.on("data", (d) => process.stderr.write(`[${name}] ${d}`));
  return p;
}

async function waitFor(fn, what, timeoutMs = 60_000) {
  const t0 = Date.now();
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {}
    if (Date.now() - t0 > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

try {
  await fetch(`${BASE}/login`);
  console.error("Port 3000 is already in use: stop the running app before the E2E run.");
  process.exit(2);
} catch {}

const server = start("npx", ["next", "start", "-H", "127.0.0.1", "-p", "3000"], "next");
const worker = start("npx", ["tsx", "src/worker/index.ts"], "worker");
let browser;
const steps = [];
const step = (s) => {
  steps.push(s);
  console.log(`✓ ${s}`);
};

try {
  await waitFor(async () => (await fetch(`${BASE}/login`)).ok, "next server");
  browser = await chromium.launch();
  const ctx = await browser.newContext({ acceptDownloads: true, viewport: { width: 1360, height: 900 } });
  const page = await ctx.newPage();
  const email = `e2e-${randomUUID().slice(0, 8)}@example.test`;
  const password = `E2e-${randomUUID().slice(0, 12)}9x`;

  await page.goto(`${BASE}/app`);
  assert.match(page.url(), /\/login$/);
  step("unauthenticated /app redirects to /login");

  await page.goto(`${BASE}/signup`);
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', password);
  await page.click('button:has-text("Create account")');
  await page.waitForURL(/check-email/);
  step("sign up → check-email page");

  const link = await waitFor(async () => {
    const r = await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${email}"`)}`);
    const j = await r.json();
    const m = j.messages?.[0];
    if (!m) return null;
    const full = await (await fetch(`${MAILPIT}/api/v1/message/${m.ID}`)).json();
    const href = /href="([^"]+auth\/confirm[^"]+)"/.exec(full.HTML)?.[1];
    return href?.replace(/&amp;/g, "&");
  }, "confirmation email");
  await page.goto(link);
  await page.waitForURL(/\/app$/);
  await page.getByText("Get started").waitFor();
  step("email confirmation link signs in and opens onboarding");
  await page.screenshot({ path: `${OUT}/01-onboarding.png`, fullPage: true });

  await page.goto(`${BASE}/app/companies`);
  await page.fill('input[name="name"]', "Sunrise Heating & Air (demo)");
  await page.fill('input[name="website"]', "example.com");
  await page.fill('input[name="industry"]', "HVAC services");
  await page.fill('input[name="country"]', "US");
  await page.click('button:has-text("Add company")');
  await page.waitForURL(/created=/);
  await page.getByText("Data space: Ready").waitFor({ timeout: 60_000 });
  assert.ok(await page.getByText("SIMULATED warehouse").isVisible());
  step("add company → data space Ready (labelled SIMULATED warehouse in local mode)");
  await page.screenshot({ path: `${OUT}/02-companies.png`, fullPage: true });

  await page.goto(`${BASE}/app/connections/csv`);
  await page.setInputFiles('input[name="file"]', "public/sample-marketing-data.csv");
  await page.click('button:has-text("Check file")');
  await page.getByTestId("csv-preview").waitFor();
  assert.ok(await page.getByText("Import these rows").isVisible());
  step("CSV upload → server-side validation preview");
  await page.screenshot({ path: `${OUT}/03-csv-preview.png`, fullPage: true });

  await page.click('button:has-text("Import these rows")');
  await page.waitForURL(/imported=1/);
  await waitFor(async () => {
    await page.reload();
    return (await page.locator('[data-testid="sync-run"]:has-text("succeeded")').count()) > 0;
  }, "csv import to finish");
  step("import queued and processed by the worker");
  await page.screenshot({ path: `${OUT}/04-connections.png`, fullPage: true });

  const bad = "date,source,campaign_name,spend\n2026-13-45,meta,X,$5\n";
  await page.goto(`${BASE}/app/connections/csv`);
  await page.setInputFiles('input[name="file"]', { name: "bad.csv", mimeType: "text/csv", buffer: Buffer.from(bad) });
  await page.click('button:has-text("Check file")');
  await page.getByText("Nothing was imported").waitFor();
  step("invalid CSV shows row/column errors and imports nothing");

  await page.goto(`${BASE}/app/analytics?from=2026-10-01&to=2026-10-31`);
  await page.getByTestId("source-table").waitFor();
  const clicksText = await page.getByTestId("kpi-clicks").innerText();
  const csv = readFileSync("public/sample-marketing-data.csv", "utf8").trim().split("\n").slice(1);
  const expectedClicks = csv.reduce((s, l) => s + (Number(l.split(",")[9]) || 0), 0);
  assert.ok(clicksText.replace(/,/g, "").includes(String(expectedClicks)), `clicks card ${clicksText} should show ${expectedClicks}`);
  step(`analytics KPIs match the CSV (clicks = ${expectedClicks})`);
  await page.screenshot({ path: `${OUT}/05-analytics.png`, fullPage: true });

  const [download] = await Promise.all([page.waitForEvent("download"), page.click('a:has-text("Export CSV")')]);
  const path = `${OUT}/export.csv`;
  await download.saveAs(path);
  const exported = readFileSync(path, "utf8");
  assert.ok(exported.startsWith("﻿"));
  assert.match(exported, /daily,2026-10-01,csv,meta_ads,USD,false,final/);
  step("export CSV downloads with provenance columns");

  const forged = await page.request.get(`${BASE}/api/export?company=00000000-0000-0000-0000-000000000000&from=2026-10-01&to=2026-10-31`);
  assert.equal(forged.status(), 404);
  step("export with a forged company id → 404");

  await page.goto(`${BASE}/app/connections`);
  await page.locator('form:has(input[name="provider_id"][value="google_ads"]) button:has-text("Try with sample data")').click();
  await page.waitForURL(/sample=1/);
  await waitFor(async () => {
    await page.reload();
    return (await page.locator('[data-testid="sync-run"]:has-text("Google Ads"):has-text("succeeded")').count()) > 0;
  }, "sample google ads sync");
  await page.goto(`${BASE}/app/analytics?days=28`);
  await page.getByText("SIMULATED — sample data.").first().waitFor();
  assert.match(await page.getByTestId("blend-note").innerText(), /only your real data/);
  await page.goto(`${BASE}/app/analytics?from=2026-10-01&to=2026-10-31`);
  assert.ok((await page.getByTestId("kpi-clicks").innerText()).replace(/,/g, "").includes(String(expectedClicks)), "sample data must not change real totals");
  step("sample Google Ads connection syncs and is labelled SIMULATED everywhere");
  await page.screenshot({ path: `${OUT}/06-analytics-with-sample.png`, fullPage: true });

  await page.goto(`${BASE}/app/settings`);
  await page.click("summary:has-text('Advanced')");
  await page.getByText("Resource registry").waitFor();
  await page.screenshot({ path: `${OUT}/07-settings-advanced.png`, fullPage: true });
  step("advanced admin section shows registry/jobs/usage");

  await page.click('button:has-text("Log out")');
  await page.waitForURL(/login/);
  await page.goto(`${BASE}/app`);
  assert.match(page.url(), /\/login$/);
  step("logout ends the session");

  console.log(`\nE2E passed: ${steps.length} steps`);
} catch (err) {
  console.error("E2E FAILED after steps:", steps);
  console.error(err);
  process.exitCode = 1;
} finally {
  await browser?.close();
  server.kill("SIGTERM");
  worker.kill("SIGTERM");
  setTimeout(() => process.exit(process.exitCode ?? 0), 500);
}
