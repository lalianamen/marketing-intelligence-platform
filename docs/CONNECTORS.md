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
