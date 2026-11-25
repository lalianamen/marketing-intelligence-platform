# Connectors

Last updated: 2026-11-23. Status meanings: **Working** = verified end-to-end in this repository;
**Implemented, not verified live** = code + mocked tests, never run against the real provider;
**Simulated** = sample-data adapter with the same shape, always labelled SIMULATED.

| Provider | Status | Mode(s) |
|---|---|---|
| CSV import | **Working** (unit, integration, E2E) | manual |
| GA4 | Implemented, **not verified live**; simulated mode working | live, simulated |
| Google Ads | Implemented, **not verified live**; simulated mode working | live, simulated |
| Meta Ads, Microsoft Advertising, Microsoft Clarity, Semrush, TikTok, Shopify, WordPress, CRM, call tracking | Planned (catalog entry only); use CSV meanwhile | — |
| Yelp Ads | `requires_partner_access`; not available, no scraping | — |

## Common contract

`src/server/connectors/types.ts`. `fetchDaily({window, externalAccountId, credentials, companyTimezone, now})`
returns records plus `apiCalls`, `complete` and `notes`. Each connector declares `finalizationDays` and `lookbackDays`.
The shared engine (`src/server/sync/runSync.ts`) handles checkpoints, late-arriving data (re-fetch the
lookback window, MERGE by grain), validation (completeness, coverage gaps, quality checks), RAW/NORMALIZED/MART
writes, freshness, usage and errors. Error codes: `auth_expired` and `permission_denied` (not retried; connection → expired/error),
`rate_limited`, `quota_exceeded`, `timeout`, `unavailable` and `incomplete_data` (retried with exponential backoff + jitter;
dead-letter after `max_attempts`, then manual "Update now").

## CSV (working)

Template: `public/sample-marketing-data.csv` (synthetic data). One row per **date + source + campaign**.

| Column | Required | Rules |
|---|---|---|
| `date` | yes | `YYYY-MM-DD`, not in the future (company timezone) |
| `source` | yes | free text, normalized to a slug (e.g. `Meta Ads` → `meta_ads`) |
| `campaign_name` | yes | use `(none)` for source totals |
| `campaign_id`, `account_id`, `account_name` | no | defaults: `name:<slug>`, `default` |
| `currency` | if spend/revenue | ISO 4217 three letters |
| `spend`, `conversions`, `revenue` | no | non-negative decimals; `1,234.50` allowed; no symbols/minus/exponent |
| `impressions`, `clicks`, `sessions`, `leads` | no | non-negative integers |
| `revenue_type` | no | `attributed` (default when revenue is given) or `billed` |

Empty cell = not available. Duplicate grain within a file = error. Errors are reported by row and column, and nothing
is stored when any error exists. An identical file (same SHA-256 per company) is detected. A new file with the same
grain **replaces** those values. Limits: 5 MB, 50,000 rows.

## GA4

**Chosen MVP path: Google Analytics Data API v1beta `runReport`** (daily report metrics), not raw events.

- Dimensions `date`, `sessionCampaignId`, `sessionCampaignName`. Metrics `sessions`, `keyEvents`, `totalRevenue`.
- Key events are stored as `conversion_type = ga4_key_event` and never added to ad-platform conversions.
  `totalRevenue` is stored as *attributed* (GA4-reported) revenue.
- Currency and timezone come from the response metadata (the property's settings).
- Lookback/finalization 3 days: GA4 daily data can take 24–48 h to process.
- Pagination: 10,000 rows per page. If not all `rowCount` rows are fetched, the run fails as `incomplete_data`.
- Quotas (standard properties): 200,000 core tokens per property per day and 40,000 per hour (see `docs/SOURCES.md`). Exhaustion → 429 → retried later.

**Alternative (not implemented): GA4 → BigQuery export.** Needs Editor on the property, Owner on the BigQuery project and
linking under Admin → Product links. Standard properties have a 1M events/day limit, and daily tables arrive with latency and can
update for up to 2 days. Raw events would land in the customer-linked project, so the platform would need cross-project
read access. Suitable for a later "raw events" tier.

**User setup:** Data Connections → GA4 → enter the property ID (GA4 Admin → Property details) → *Connect with Google* →
Google consent screen (scope `analytics.readonly`). The signed-in Google user must have access to the property.

## Google Ads

**Chosen path: Google Ads API REST `customers/{id}/googleAds:searchStream`** with GAQL:
campaign × `segments.date` → `impressions`, `clicks`, `cost_micros` (÷1,000,000 = spend), `conversions`
(ad-platform conversions per the account's settings), `conversions_value` (attributed revenue). Account currency
and time zone come from `customer.*`.

- Lookback/finalization 14 days, because conversions can be attributed back to the click date within the conversion window.
- Access requirements (verify before going live; see `docs/SOURCES.md`): OAuth scope `adwords`; a Google Cloud
  project with Google Ads API access at an access level that allows production accounts (Test access works only on
  test accounts; Explorer has 2,880 ops/day). Google's developer-token page states that developer tokens were sunset on
  2026-09-09. The adapter sends `developer-token` only if `GOOGLE_ADS_DEVELOPER_TOKEN` is set.
  `login-customer-id` is needed when access comes through a manager account (`GOOGLE_ADS_LOGIN_CUSTOMER_ID`).
- **An OAuth login alone does not grant report access.** The signed-in user must have access to the customer account.
  Otherwise `USER_PERMISSION_DENIED` → the connection shows an error.
- API version: `GOOGLE_ADS_API_VERSION` (default `v26`). Google retires versions regularly, so check the release notes.
- Alternative (not implemented): BigQuery Data Transfer Service for Google Ads (billable transfers into the customer's/our project).

## Administrator prerequisites for live Google connectors

1. Google Cloud project → enable *Google Analytics Data API*, *Google Analytics Admin API* and *Google Ads API*.
2. OAuth consent screen. While in **Testing** status: at most 100 test users, and refresh tokens expire after **7 days**
   (the app shows "Needs reconnecting"). For production: publishing and possibly Google verification of the scopes.
   Whether `analytics.readonly` / `adwords` count as sensitive scopes is **not verified**: check the Data Access page.
3. OAuth client (Web application), redirect URI `http://127.0.0.1:3000/api/oauth/google/callback` for local development.
4. Set `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET` and `TOKEN_ENCRYPTION_KEY` in `.env.local` (never commit them).
5. Google Ads: confirm the project's API access level and the user's account access.

**Account discovery (built).** The user only clicks "Connect with Google". After consent the callback lists what the
Google user can read and connects it:
- GA4: Google Analytics Admin API `v1beta/accountSummaries` (needs the *Google Analytics Admin API* enabled in the
  app's Google Cloud project; scope `analytics.readonly`).
- Google Ads: `customers:listAccessibleCustomers`, plus `customer.descriptive_name` per account (manager accounts are skipped).
- One account → connected at once and the first import starts. Several → `/app/connections/choose`, where the user
  ticks the ones that belong to the company. The refresh token waits encrypted in `oauth_pending_grants`
  (server-only, 30 minutes) and each chosen account gets its own encrypted copy.
- Typing the ID manually is still possible ("Enter the ID manually instead").
- The "Add a connector" page lists only what can be connected now: CSV, GA4, and Google Ads only when
  `GOOGLE_ADS_ENABLED=true` (set it once Google approves API access for real accounts). "Try with sample data" is shown
  only where live Google sign-in is not configured (local development).

## Connector page (`/app/connections/<id>`)

- Status, account, last update and data date, in the company's time zone.
- **Automatic updates**: every day at a chosen local time, or only manual ("Update now"). Owner/admin/member only.
- **Update history** of this connector and a **Raw data** table: the provider's records as stored in `raw_records`
  (GA4 values labelled with the requested dimension/metric names, nested payloads flattened), newest days first,
  identical payloads from repeated updates shown once, latest 500 rows.
- **Disconnect** stops updates and removes the stored sign-in; imported data stays.
- **Delete** removes the connector and the data it imported (its normalized rows: same origin, simulation flag and,
  for live connectors, account; its raw rows by sync run), rebuilds the mart for the affected days, then deletes runs,
  schedule and token. Refused while an update is running.

## Setup before the first load

- A newly connected live source loads nothing (`company_connections.activated_at` is null, schedule off). The connector
  page shows setup: 1) which data groups to collect, 2) the period (default last 30 complete days, up to 400), 3) daily
  time or manual only, with a note to switch everything on before the first load. "Start loading" saves the schedule,
  queues the period in parts of up to one month (`request_history`) and sets `activated_at`.
- Reconnecting after an expired sign-in keeps the schedule; reconnecting a disconnected connector goes through setup again.
- Selection is per field: a group's switch adds or removes all its fields, a checkbox adds or removes one field.
  `settings.ga4_reports` stores field names (older settings with group ids mean all fields of the group).
  Base fields are always on (they feed the dashboard): date, campaign name, sessions, key events, total revenue.
  `sessionCampaignId` is optional (group "Campaign ID"); without it campaigns are keyed by name (`name:<campaign>`).
  Migration `20261125000008` kept it switched on for connectors that had already loaded data. A removed breakdown is summed into the remaining rows.
- Switches are a draft (`Ga4GroupPicker`): nothing is saved or deleted until Save; "Undo changes" restores the
  saved set; the bar shows the live counts and what will be added or removed. In setup, Save only stores the set.
- After the first load, Save (with at least one real change) asks for confirmation: all data of the connector (dashboard
  rows and raw rows, in the warehouse and in the table) is deleted, the dashboard days are rebuilt, queued parts are
  cancelled and only the last 30 complete days are loaded again with the new columns. Older days can be added with
  Load history. This keeps every row of the table in one format; loading again takes time.

## Raw data table and export

- Connector page → Raw data: period (7/30/90 days, all, or from–to; default last 30 complete days), up to three
  column filters (contains, equals, >, <; numbers compared as numbers), sorting by clicking a column, 100 rows per page
  with the total count. Filtering, sorting and paging run in the warehouse (`queryRawPage`), not in the browser.
- Columns map to JSON paths in `payload_json` (GA4 and CSV fields by name; GA4 rows stored before the one-table change keep the base fields by position and are still shown). Paths are
  validated to `[A-Za-z0-9_]` segments before they are used in SQL.
- `/app/connections/<id>/export`: CSV of the current view, or `full=1` for the whole stored period without filters;
  at most 50,000 rows per file; UTF-8 with BOM; cells starting with = + - @ are prefixed to stop spreadsheet formulas.

## GA4: one table, switchable data groups

- Catalog: `src/lib/ga4Catalog.ts` (one source of truth for field names, descriptions and GA4 limits). Base fields
  (date, campaign id/name, sessions, key events, total revenue) are always requested and feed the dashboard.
- Optional groups (traffic sources, devices, geography, landing pages, engagement, users, conversions) are switched
  on/off per connector (`company_connections.settings.ga4_reports`, written by the server after an access check).
  Each switched-on group adds its columns to the same table: one `runReport` with base + group fields.
- GA4 allows at most 9 dimensions and 10 metrics per request; a selection over the limit is refused before anything
  changes (`ga4SelectionProblem`), the page marks such groups "limit reached".
- Each raw row's id includes all requested dimension values (`rawKey`), so rows split by a breakdown stay separate;
  for the dashboard, rows of one campaign and day are summed back, so totals do not change when columns are added.
- Planned: plan tiers will mark groups as basic or extended; switching is then checked against the workspace plan.

## GA4 full data (BigQuery export, ADR 0006)

- Connector page → Full data → "Turn on full data": Google's consent screen with GA4 edit / manage-users permissions
  (the Google account needs the Administrator role on the property). The platform service account is added to the
  property, creates the daily export link to the platform project and is removed again; the page then shows
  "waiting for the first day" until `events_YYYYMMDD` appears (usually within 24 h), then "on" with the exported range.
- Exported days are built from events with any columns (no limit of 9 / 10); other days use the Data API.
- "Turn off" or deleting the connector removes the link in GA4 and deletes `analytics_<property>`.
- State: `public.ga4_export_links` (server only). Code: `src/server/ga4export/`, `src/server/connectors/ga4Admin.ts`.

## Google Search Console (working)

- Same model as GA4: Connect with Google (scope `webmasters.readonly`) → the user's verified sites are listed →
  setup page (columns, period, schedule) → one table; changing columns asks before deleting and reloading 30 days.
- Columns (`src/lib/gscCatalog.ts`, saved in `company_connections.settings.columns`): base `date`, `clicks`,
  `impressions`, `ctr`, `position`; optional `query`, `page`, `country`, `device`. No column limit.
- Search Analytics API (`searchAnalytics.query`, type web, dataState all, 25,000 rows per page). Search Console hides
  rare queries, so the dashboard uses a separate per-day total (records with role `dashboard`); table rows have role
  `table` and are not summed. `ctr` and `position` are per row and never added up. Dates are Pacific Time; the last
  ~3 days are preliminary and re-read (lookback 4 days).
- Administrator: enable `searchconsole.googleapis.com` in the OAuth client's Cloud project.

## Microsoft Clarity (working)

- Connect: Add connector → Microsoft Clarity → project ID + project API token (Clarity → Settings → Data Export →
  Generate new API token). The token is checked with one request, stored encrypted like OAuth tokens, never shown again.
- Data Export API `project-live-insights` (Microsoft limits: 10 requests per project per day, at most 3 breakdowns,
  1,000 rows, last 1–3 days only, no dates in the answer, UTC). One load = `numOfDays=1` (last 24 hours), filed under
  the previous day; the schedule defaults to 00:30; whatever window a run asks for, it is set to that one day
  (`Connector.singleDay`), so replacing never touches other days. No history load.
- Columns: breakdowns `source, medium, campaign, channel, device, os, browser, country, url` (max 3,
  `src/lib/clarityCatalog.ts`); every number Clarity returns is stored as `<metricName>.<field>` and shown as columns.
- Clarity numbers are not added to dashboard totals (its sessions would repeat GA4's): one empty dashboard row per day
  keeps the day's coverage; the table holds the numbers.

## Future connectors: design notes, no access promised

| Provider | Notes |
|---|---|
| Meta Ads | Marketing API; app review + business verification likely needed. Not verified |
| Microsoft Advertising | Reporting API; developer token required. Not verified |
| Microsoft Clarity | Data export API with limited history. Not verified |
| Semrush | Paid API units (see Semrush pricing). Not verified |
| TikTok Ads | Marketing API app approval. Not verified |
| Shopify | Admin API (orders → billed revenue). Not verified |
| WordPress | Site plugin or form/webhook integration. Not verified |
| CRM | Per CRM (HubSpot, Salesforce…). Would supply leads/billed revenue; personal data would need a privacy design first |
| **Yelp** | Ads API: "Access is not available by default"; partner APIs are reserved for contracted partners; the API terms restrict storage (24 h), commercial analysis, and use on behalf of third parties. Marked `requires_partner_access`. **No scraping.** Use CSV exports from the Yelp business account meanwhile, where the user is entitled to them |
| Call tracking | Would involve personal data and recordings. Out of scope until a privacy design is approved |
