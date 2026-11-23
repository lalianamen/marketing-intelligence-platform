# Execution checklist (Phase 1)

Last updated: 2026-11-23. ✅ done and tested · 🟡 done, mock/simulation only · ⛔ blocked by external access/approval · ⏭ deferred.

- ✅ Isolated new project directory, separate git repository (no LICENA code touched)
- ✅ Official docs checked for BigQuery, GA4, Google Ads, OAuth, Supabase, Yelp, billing (`docs/SOURCES.md`)
- ✅ Requirements, architecture, data model, security, costs, connectors, operations, roadmap, threats, ADRs
- ✅ Next.js 16 App Router + TypeScript + Tailwind app; protected routes via `proxy.ts`
- ✅ Supabase migrations: tables, RLS, RPCs, rate limits, reference data
- ✅ Auth: sign-up, email verification (token_hash), login/logout, password reset, idempotent workspace bootstrap
- ✅ Companies: create (transactional job), status Pending/Preparing/Ready/Failed, retry
- ✅ Worker: Postgres queue, leases, fencing, backoff, dead-letter, lease recovery, reconciliation, central scheduler
- ✅ Local simulated warehouse (dataset per company), labelled SIMULATED
- 🟡 BigQuery adapter (official SDK, ADC, labels, 409 adoption, partitioned/clustered DDL, MERGE, maximumBytesBilled): unit-tested with a mocked SDK
- ⛔ Real BigQuery dataset creation: needs a dev project, credentials and billing approval
- ✅ CSV import end to end (validation, preview, dedup, isolation, KPIs, export)
- 🟡 GA4 connector (Data API) and Google Ads connector (searchStream): mocked HTTP tests; simulated modes work end to end
- ⛔ Live GA4 / Google Ads: needs admin OAuth client, API enablement and account access
- ✅ OAuth start/callback (state + PKCE + encrypted refresh token): implemented; ⛔ not exercised against Google
- ✅ KPI engine, dashboard, analytics (comparison, charts, sources, campaigns), freshness, failures, data-quality notes
- ✅ CSV export (Excel-compatible, formula-safe); ⏭ XLSX
- ✅ Usage instrumentation with estimated vs actual separation; ⏭ Cloud Billing export reconciliation
- ✅ Secret scans (repo + client bundle), CI workflow file (⛔ not executed: the repository is not on GitHub yet)
- ✅ Unit, integration and E2E tests passing locally
- ⛔ Public GitHub repository: this session's GitHub access is limited to an existing repository (see README)
- ✅ Not deployed anywhere; no billable resources created
