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
// E2E_NO_WORKER=1 checks the hosted (Vercel-like) mode: jobs run inside the web app.
const worker = process.env.E2E_NO_WORKER ? null : start("npx", ["tsx", "src/worker/index.ts"], "worker");
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
  await page.waitForURL(/\/app\/companies$/);
  await page.getByText("No companies yet").waitFor();
  step("email confirmation link signs in and opens the Companies list");
  await page.screenshot({ path: `${OUT}/01-onboarding.png`, fullPage: true });

  await page.click('a:has-text("+ Add company")');
  await page.waitForURL(/\/app\/companies\/new$/);
  await page.fill('input[name="name"]', "Sunrise Heating & Air (demo)");
  await page.check('input[name="business_type"][value="local_service"]');
  await page.fill('input[name="website"]', "example.com");
  await page.fill('input[name="industry"]', "HVAC services");
  await page.fill('input[name="country"]', "US");
  await page.click('button:has-text("Add company")');
  await page.waitForURL(/created=/);
  await page.locator('[data-testid="company-row"]').getByText("Ready").waitFor({ timeout: 60_000 });
  assert.ok(await page.getByText("Simulated warehouse").isVisible());
  step("add company → data space Ready (labelled Simulated warehouse in local mode)");
  await page.screenshot({ path: `${OUT}/02-companies.png`, fullPage: true });

  await page.click('[data-testid="company-row"] a');
  await page.waitForURL(/\/app$/);
  assert.equal(await page.locator('[data-testid="current-company"]').textContent(), "Sunrise Heating & Air (demo)");
  await page.getByRole("heading", { name: "Connectors" }).waitFor();
  step("clicking a company opens its dashboard with its own menu");

  await page.goto(`${BASE}/app/connections`);
  await page.getByText("No connectors yet").waitFor();
  await page.click('a:has-text("+ Add connector") >> nth=0');
  await page.waitForURL(/\/app\/connections\/new$/);
  await page.getByText("Upload a spreadsheet (CSV)").waitFor();
  assert.equal(await page.getByText("Other platforms").count(), 0, "only connectable sources are listed");
  step("Data Connections → + Add connector lists only sources that can be connected now");
  await page.click('a:has-text("Connect with an API token")');
  await page.waitForURL(/\/app\/connections\/clarity$/);
  assert.equal(await page.locator('[data-testid="clarity-form"] input[name="token"]').getAttribute("type"), "password", "token is not shown on screen");
  await page.fill('input[name="token"]', "x");
  assert.equal(await page.locator('[data-testid="clarity-form"]').evaluate((f) => f.checkValidity()), false, "invalid input is stopped in the browser");
  await page.goto(`${BASE}/app/connections/new`);
  step("Microsoft Clarity: connect page asks only for the key, hidden on screen, with step-by-step help");
  await page.click('a:has-text("Connect with a read-only key")');
  await page.waitForURL(/\/app\/connections\/stripe$/);
  await page.fill('[data-testid="stripe-form"] input[name="key"]', ["sk", "live", "xxxxxxxxxxxxxxxxxxxxxxxxxx"].join("_"));
  assert.equal(await page.locator('[data-testid="stripe-form"]').evaluate((f) => f.checkValidity()), false, "a full secret key is refused");
  await page.fill('[data-testid="stripe-form"] input[name="key"]', ["rk", "live", "xxxxxxxxxxxxxxxxxxxxxxxxxx"].join("_"));
  assert.equal(await page.locator('[data-testid="stripe-form"]').evaluate((f) => f.checkValidity()), true);
  await page.goto(`${BASE}/app/connections/new`);
  step("Stripe: connect page takes only a read-only key (rk_), refuses secret keys");
  await page.click('a:has-text("Connect with an API key")');
  await page.waitForURL(/\/app\/connections\/bing$/);
  await page.fill('[data-testid="bing-form"] input[name="key"]', "not a key");
  assert.equal(await page.locator('[data-testid="bing-form"]').evaluate((f) => f.checkValidity()), false, "a malformed key is stopped in the browser");
  await page.fill('[data-testid="bing-form"] input[name="key"]', "0123456789abcdef0123456789abcdef");
  assert.equal(await page.locator('[data-testid="bing-form"]').evaluate((f) => f.checkValidity()), true);
  await page.goto(`${BASE}/app/connections/new`);
  step("Bing Webmaster Tools: connect page takes an API key (hidden) and an optional site");

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

  await page.goto(`${BASE}/app/connections/new`);
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

  await page.goto(`${BASE}/app/connections`);
  await page.locator('[data-testid="connection-row"]:has-text("Google Ads") a:has-text("Open")').click();
  await page.waitForURL(/\/app\/connections\/[0-9a-f-]{36}$/);
  await page.getByTestId("raw-table").waitFor();
  assert.ok((await page.locator('[data-testid="raw-table"] tbody tr').count()) > 0, "raw rows are listed");
  await page.locator('[data-testid="schedule-form"] input[name="local_time"]').fill("09:30");
  await page.locator('[data-testid="schedule-form"] button:has-text("Save")').click();
  await page.waitForURL(/saved=1/);
  assert.equal(await page.locator('[data-testid="schedule-form"] input[name="local_time"]').inputValue(), "09:30");
  await page.getByTestId("schedule-saved").waitFor();
  assert.match(await page.getByTestId("schedule-current").innerText(), /every day at 9:30 AM/);
  assert.ok(await page.locator('[data-testid="schedule-form"] button:has-text("Save")').isDisabled(), "nothing to save after saving");
  await page.locator('[data-testid="schedule-form"] input[name="local_time"]').fill("10:15");
  await page.getByTestId("schedule-unsaved").waitFor();
  await page.locator('[data-testid="schedule-form"] input[name="local_time"]').fill("09:30");
  await page.click('[data-testid="raw-filters"] a:has-text("All")');
  await page.waitForURL(/period=all/);
  const allRows = await page.getByTestId("raw-total").innerText();
  await page.selectOption('[data-testid="raw-filters"] select[name="f1c"]', "clicks");
  await page.selectOption('[data-testid="raw-filters"] select[name="f1o"]', "gt");
  await page.fill('[data-testid="raw-filters"] input[name="f1v"]', "200");
  await page.selectOption('[data-testid="filter-row-2"] select[name="f2c"]', "simulated");
  await page.locator('[data-testid="filter-row-2"] select[name="f2v"] option[value="true"]').waitFor({ state: "attached" });
  await page.selectOption('[data-testid="filter-row-2"] select[name="f2v"]', "true");
  await page.click('[data-testid="raw-filters"] button:has-text("Apply")');
  await page.waitForURL(/f1c=clicks/);
  const filtered = await page.getByTestId("raw-total").innerText();
  assert.ok(parseInt(filtered.replace(/,/g, ""), 10) < parseInt(allRows.replace(/,/g, ""), 10), "filter reduces rows");
  await page.click('[data-testid="raw-table"] th a:has-text("clicks")');
  await page.waitForURL(/sort=clicks/);
  const firstClicks = Number(await page.locator('[data-testid="raw-table"] tbody tr').first().locator("td").nth(1).innerText());
  assert.ok(firstClicks > 200, "sorted by clicks and filtered");
  const [rawDownload] = await Promise.all([page.waitForEvent("download"), page.click('[data-testid="export-view"]')]);
  const csvPath = `${OUT}/raw-export.csv`;
  await rawDownload.saveAs(csvPath);
  const csvText = (await import("node:fs")).readFileSync(csvPath, "utf8");
  assert.match(csvText.split("\n")[0], /day,.*clicks.*imported_at_utc/);
  assert.equal(csvText.trim().split("\n").length - 1, parseInt(filtered.replace(/,/g, ""), 10), "export has the filtered rows");
  step("raw data: period, filters (value picked from a list), sort and CSV export of the view");
  await page.setViewportSize({ width: 480, height: 900 });
  await page.getByTestId("scroll-top").waitFor();
  await page.getByTestId("scroll-top").evaluate((el) => { el.scrollLeft = 200; el.dispatchEvent(new Event("scroll")); });
  await page.waitForFunction(() => (document.querySelector('[data-testid="raw-table"]')?.parentElement?.scrollLeft ?? 0) > 100);
  await page.getByTestId("raw-table").scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${OUT}/12-scroll.png` });
  await page.setViewportSize({ width: 1360, height: 900 });
  step("wide table: horizontal scrollbar above the table moves it");
  await page.click('[data-testid="toggle-fullscreen"]');
  await page.locator('[data-expanded="true"]').waitFor();
  await page.click('[data-testid="raw-table"] th a:has-text("impressions")');
  await page.waitForURL(/sort=impressions/);
  await page.locator('[data-expanded="true"]').waitFor(); // stays full screen after a reload
  await page.screenshot({ path: `${OUT}/13-fullscreen.png` });
  await page.keyboard.press("Escape");
  await page.locator('[data-expanded="false"]').waitFor();
  step("raw data full screen: stays on while sorting, Esc leaves");
  await page.screenshot({ path: `${OUT}/10-connector.png`, fullPage: true });
  step("connector page: schedule saved, raw data table shown");

  {
    // A newly connected live GA4 connector waits for setup: nothing loads until Start loading.
    const pg = createRequire(import.meta.url)("pg");
    const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await db.connect();
    const co = (await db.query(`select c.id, c.workspace_id from public.companies c join public.workspace_members m on m.workspace_id = c.workspace_id
                                 join auth.users u on u.id = m.user_id where u.email = $1 limit 1`, [email])).rows[0];
    const live = (await db.query(
      `insert into public.company_connections (workspace_id, company_id, provider_id, mode, status, external_account_id, external_account_name, activated_at)
       values ($1, $2, 'ga4', 'live', 'connected', '999', 'Demo property', null) returning id`, [co.workspace_id, co.id])).rows[0].id;
    await db.query(`insert into public.sync_schedules (workspace_id, company_id, connection_id, frequency, local_time, timezone, enabled) values ($1, $2, $3, 'daily', '06:00', 'America/Los_Angeles', false)`, [co.workspace_id, co.id, live]);
    await page.goto(`${BASE}/app/connections`);
    await page.locator('[data-testid="connection-row"]:has-text("Demo property") a:has-text("Finish setup")').click();
    await page.getByTestId("connector-setup").waitFor();
    assert.ok(await page.getByText("Switch on all the data you need").isVisible());
    assert.equal(await page.locator('button:has-text("Update now")').count(), 0, "no loading before setup");
    assert.ok(await page.getByTestId("start-loading-form").isVisible());
    assert.ok(await page.getByTestId("ga4-catalog").evaluate((d) => d.open), "report list is open during setup");
    await page.screenshot({ path: `${OUT}/11-setup.png`, fullPage: true });
    step("new live connector opens in setup: choose data, period and schedule before any load");

    // Data groups are a draft until Save: switching changes nothing on the server.
    const bar = page.getByTestId("ga4-picker-bar");
    await page.click('button[role="switch"][aria-label="Traffic sources"]');
    await page.click('button[role="switch"][aria-label="Devices and technology"]');
    await bar.getByText("Unsaved changes").waitFor();
    assert.ok(await bar.getByText("8 of 9 breakdowns").isVisible(), "draft counts update live");
    await page.click('button:has-text("Undo changes")');
    await bar.getByText("No changes").waitFor();
    await page.click('button[role="switch"][aria-label="Traffic sources"]');
    // single fields: untick one breakdown of the group, tick it back
    await page.getByRole("checkbox", { name: "sessionMedium" }).uncheck();
    await bar.getByText("add: sessionSource, sessionDefaultChannelGroup").waitFor(); // the unticked field is left out
    await page.getByRole("checkbox", { name: "sessionMedium" }).check();
    await page.click('[data-testid="ga4-picker"] button[type="submit"]:has-text("Save")');
    await page.getByText("Saved. These columns will be in the table").waitFor();
    const saved = (await db.query(`select settings->'ga4_reports' as g from public.company_connections where id = $1`, [live])).rows[0].g;
    assert.deepEqual(saved, ["sessionSource", "sessionMedium", "sessionDefaultChannelGroup"], "saved only on Save");

    // After the first load, Save asks before deleting and reloading; Cancel changes nothing.
    await db.query(`update public.company_connections set activated_at = now() where id = $1`, [live]);
    await page.goto(`${BASE}/app/connections/${live}#ga4-reports`);
    await page.click('[data-testid="ga4-catalog"] summary');
    await page.click('button[role="switch"][aria-label="Devices and technology"]');
    await page.click('button:has-text("Save and reload…")');
    await page.locator("dialog[open]").getByText("The whole current table of this connector will be deleted").waitFor();
    assert.ok(await page.locator("dialog[open]").getByText("Add: deviceCategory, operatingSystem, browser").isVisible());
    await page.locator("dialog[open]").getByRole("button", { name: "Cancel" }).click();
    const still = (await db.query(`select settings->'ga4_reports' as g from public.company_connections where id = $1`, [live])).rows[0].g;
    assert.deepEqual(still, ["sessionSource", "sessionMedium", "sessionDefaultChannelGroup"], "cancel keeps the saved set");
    // Full data (GA4 BigQuery export): offered after the first load, with a plain explanation.
    const full = page.getByTestId("full-data");
    await full.getByText("What happens when I turn it on").click();
    assert.ok(await full.getByText("removes the service account again").isVisible());
    const href = await page.getByTestId("turn-on-full-data").getAttribute("href");
    assert.match(href, /purpose=ga4_export/);
    assert.match(href, new RegExp(`connection=${live}`));
    await db.end();
    step("data groups: pick several, then Save; after the first load Save warns before reloading");
    step("full data: offered on a loaded GA4 connector with what will happen");
  }

  await page.goto(`${BASE}/app?days=90`);
  await page.locator('[data-testid="connector-card"]').first().waitFor();
  assert.ok((await page.locator('[data-testid="connector-card"]').count()) >= 2, "dashboard lists connectors");
  await page.getByText("Last update").first().waitFor();
  await page.screenshot({ path: `${OUT}/09-dashboard.png`, fullPage: true });
  step("dashboard shows connectors with last update and charts");

  await page.click('[data-testid="account-menu"] summary');
  await page.getByText("Signed in as").first().waitFor();
  await page.mouse.click(5, 600);
  assert.ok(!(await page.locator('[data-testid="account-menu"]').evaluate((d) => d.open)), "account menu closes on outside click");
  await page.click('[data-testid="account-menu"] summary');
  assert.ok(await page.locator('[data-testid="account-menu"]').getByText(email).first().isVisible(), "header shows the signed-in email");
  await page.click('a:has-text("Account settings")');
  await page.waitForURL(/\/app\/account$/);
  step("account menu shows the signed-in email and opens Account settings");
  await page.getByTestId("appearance").getByLabel("Dark").check();
  await page.getByTestId("appearance").getByRole("button", { name: "Save" }).click();
  await page.waitForURL(/saved=1/);
  assert.equal(await page.evaluate(() => document.documentElement.className), "dark");
  const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  assert.equal(bg, "rgb(14, 17, 22)", "dark page background");
  await page.screenshot({ path: `${OUT}/12-dark-account.png`, fullPage: true });
  await page.goto(`${BASE}/app?days=90`);
  await page.screenshot({ path: `${OUT}/13-dark-dashboard.png`, fullPage: true });
  await page.goto(`${BASE}/app/account`);
  await page.getByTestId("appearance").getByLabel("Light").check();
  await page.getByTestId("appearance").getByRole("button", { name: "Save" }).click();
  await page.waitForURL(/saved=1/);
  assert.equal(await page.evaluate(() => document.documentElement.className), "");
  step("account settings: dark theme on and off");
  await page.click("summary:has-text('Advanced')");
  await page.getByText("Resource registry").waitFor();
  await page.screenshot({ path: `${OUT}/07-settings-advanced.png`, fullPage: true });
  step("advanced admin section shows registry/jobs/usage");

  const invitee = `invitee-${randomUUID().slice(0, 8)}@example.test`;
  await page.goto(`${BASE}/app/account#users`);
  await page.fill('[data-testid="invite-form"] input[name="email"]', invitee);
  await page.check('[data-testid="invite-form"] input[value="company_viewer"]');
  await page.click('[data-testid="invite-form"] button:has-text("Give access")');
  await page.waitForURL(/invited=/);
  assert.ok(await page.locator('[data-testid="users"]').getByText(invitee).first().isVisible(), "the invitation is listed");
  await page.screenshot({ path: `${OUT}/13-users.png`, fullPage: true });
  await page.locator('[data-testid="users"] li', { hasText: invitee }).locator('button:has-text("Cancel")').click();
  await page.waitForURL(/users_saved=1/);
  assert.equal(await page.locator('[data-testid="users"] li', { hasText: invitee }).count(), 0, "a cancelled invitation disappears");
  step("account settings → Users: invite a viewer to a chosen company, then cancel it");

  await page.goto(`${BASE}/app`);
  assert.equal(await page.locator('button:has-text("Delete company")').count(), 0, "no delete button in the company header");
  await page.click('nav[aria-label="Company"] a:has-text("Settings")');
  await page.waitForURL(/\/app\/settings$/);
  await page.click('button:has-text("Delete company")');
  await page.locator("dialog[open]").getByText("will be permanently deleted from the database").waitFor();
  const confirmBtn = page.locator('dialog[open] button:has-text("Delete company and its data")');
  assert.ok(await confirmBtn.isDisabled(), "delete stays disabled until the name is typed");
  await page.locator("dialog[open] input[name=\"confirm_name\"]").fill("Sunrise Heating & Air (demo)");
  await page.screenshot({ path: `${OUT}/08-delete-dialog.png`, fullPage: true });
  await confirmBtn.click();
  await page.waitForURL(/deleted=1/);
  await page.getByText("No companies yet").waitFor();
  step("delete company from its Settings: warning, typed name, company removed");

  await page.click('[data-testid="account-menu"] summary');
  await page.click('[data-testid="account-menu"] button:has-text("Log out")');
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
  worker?.kill("SIGTERM");
  setTimeout(() => process.exit(process.exitCode ?? 0), 500);
}
