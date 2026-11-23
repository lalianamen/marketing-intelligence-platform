# Product requirements — Phase 1 (analytics MVP)

Last updated: 2026-11-23. Status column: **Done** = implemented and covered by automated tests in
this repository; **Done (mock)** = implemented, verified only against mocks/simulation;
**Not verified live** = code exists but was never run against the real provider.

## Users and goal

- **Business owner** (non-technical): sees how their marketing performs without learning BigQuery, IAM or SQL.
- **Agency**: manages many client companies in one workspace without mixing their data.

Core journey: **Register → create company → connect an approved source or upload CSV → data is collected and structured automatically → understandable KPI analytics.**

## User stories and acceptance criteria

| # | Story | Acceptance criteria | Status | Test |
|---|---|---|---|---|
| 1 | As a visitor I can register with email + password | Weak passwords rejected; no session until the email is confirmed; confirmation link signs me in; same response for existing emails | Done | `tests/integration/auth.test.ts`, E2E |
| 2 | As a user I can log in / log out / reset my password | Wrong password → generic error; logout invalidates session; reset email → new password works, old fails | Done | `auth.test.ts`, E2E |
| 3 | After verification I get a workspace automatically | Exactly one workspace + owner membership, idempotent under concurrent calls; never created before verification; not coupled to Google Cloud availability | Done | `auth.test.ts` |
| 4 | I can add several companies | Form asks only name (required), website, industry, country, timezone; company + provisioning job created in one transaction; per-workspace cap and rate limit | Done | `tenancy.test.ts`, E2E |
| 5 | Each company gets an isolated data space | Status shown as Pending / Preparing / Ready / Failed without blocking; dataset per company; deterministic dataset id; retries never duplicate; failed → Retry button | Done in local simulated warehouse; BigQuery path **Done (mock)**, **not verified live** | `provisioning.test.ts`, `adapters.test.ts` |
| 6 | Mock mode is never shown as real | Local warehouse labelled "SIMULATED warehouse"; sample connectors labelled SIMULATED on every screen and in exports; sample rows never blended into real totals | Done | `kpi.test.ts`, E2E |
| 7 | I can upload a CSV | Template + synthetic sample; server-side validation (size, rows, columns, dates, numbers, currency, duplicates); preview with row/column errors; nothing stored on error; idempotent re-upload; corrected rows replace the same grain | Done | `csv.test.ts`, `pipeline.test.ts`, E2E |
| 8 | I can connect GA4 | Official Google consent screen (OAuth code + PKCE + state); daily report metrics via Data API; plain-language status; expired authorization → "Needs reconnecting" | Done (mock); **not verified live** — needs admin OAuth client | `adapters.test.ts`, `pipeline.test.ts` |
| 9 | I can connect Google Ads | Same flow; campaign × day cost/impressions/clicks/conversions via Google Ads API | Done (mock); **not verified live** — needs admin OAuth client + Ads API access | `adapters.test.ts` |
| 10 | Data updates automatically | Central daily schedule per connection at company-local time + provider buffer + jitter; incremental cursor; lookback re-fetch for late data; retries with backoff; dead-letter + manual "Update now" | Done | `pipeline.test.ts`, `time-and-sync.test.ts` |
| 11 | I see understandable KPIs | Cards (spend, impressions, clicks, sessions, CTR, CPC, CPM), comparison to previous period, daily charts, by-source table, campaign table, freshness, failures, data-quality notes; missing inputs → "Not available" | Done | `kpi.test.ts`, E2E |
| 12 | I can export a report | CSV (UTF-8 BOM, Excel-compatible), provenance columns, formula-injection-safe | Done. XLSX: not implemented (deferred) | `security-units.test.ts`, E2E |
| 13 | I never see another company's data | RLS + server authorization on every operation; forged ids → "not found" | Done | `tenancy.test.ts`, E2E |
| 14 | Admin can see technical details | Settings → Advanced: warehouse mode, registry (project/dataset), jobs, usage estimates, audit log | Done | E2E |

## Non-functional requirements

- Local-only. No deployment, no billable resource created by default (`BIGQUERY_BILLING_APPROVED=false`).
- No secrets in the repository or client bundle (`npm run check:secrets`, `npm run check:bundle`, gitleaks in CI).
- Every warehouse query is date-bounded (max 400 days) and, in BigQuery, capped by `maximumBytesBilled`.
- Plain-language UI; technical details only in Settings → Advanced.

## Explicitly out of scope (Phase 1)

AI chatbot/analyst, campaign launching/budget management, Yelp partner data, cross-posting, media studio,
team chat, voice AI/call recording, CRM automation, Stripe/payments, public deployment, XLSX export,
team invitations UI, account picker after Google consent (the user types the property/customer ID).
