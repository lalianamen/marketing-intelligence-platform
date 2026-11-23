# Marketing Intelligence Platform — Phase 1

Multi-tenant marketing analytics for business owners and agencies: register, add companies, connect
data sources or upload a CSV, and see understandable KPIs. Each company's data lives in its own
isolated analytics dataset.

**Phase 1 is local-only.** It is not deployed, and no cloud billing is used by default.

## What works today

| Area | State |
|---|---|
| Sign-up with email verification, login/logout, password reset, automatic workspace | Working (tested against local Supabase) |
| Multiple companies per workspace, strict tenant isolation (RLS + server checks) | Working (tested) |
| Per-company data space, provisioned by a background worker with retries/crash recovery | Working in the **local simulated warehouse**; real BigQuery path implemented but **not run against Google** |
| CSV import → validation → RAW/NORMALIZED/MART → dashboard → CSV export | Working end to end |
| GA4 and Google Ads connectors | Code + mocked tests; **not verified live**. Sample-data mode works and is labelled **SIMULATED** |
| Daily scheduled syncs, incremental cursors, late-arriving data, backoff, dead-letter | Working (simulated connectors) |
| KPI engine (CPC, CTR, CPM, CPL, conversion rate, ROAS), comparisons, charts, freshness | Working |

Full status: [`docs/EXECUTION_CHECKLIST.md`](docs/EXECUTION_CHECKLIST.md).

## Quick start

```bash
npm ci
npm run db:start        # local Supabase in Docker (Postgres, Auth, Mailpit); applies migrations
npm run env:local       # creates git-ignored .env.local
npm run dev             # http://127.0.0.1:3000
npm run worker          # in a second terminal
```

Confirmation emails: http://127.0.0.1:54324 (Mailpit). Sample data to upload:
[`public/sample-marketing-data.csv`](public/sample-marketing-data.csv) (synthetic).

## Tests

```bash
npm run typecheck
npm test                         # 65 unit tests
npm run test:integration         # 42 integration tests (needs db:start + env:local)
npm run build && npm run test:e2e   # browser journey (14 steps); E2E_NO_WORKER=1 checks hosted mode
npm run check:secrets && npm run check:bundle
```

## Documentation

- [Product requirements](docs/PRODUCT_REQUIREMENTS.md) · [Architecture](docs/ARCHITECTURE.md) · [Data model](docs/DATA_MODEL.md)
- [Security](docs/SECURITY.md) · [Threats and costs](docs/THREATS_AND_COSTS.md) · [Costs](docs/COSTS.md)
- [Connectors](docs/CONNECTORS.md) (GA4, Google Ads, CSV, future providers, access blockers)
- [Deployment (hosted platform, prepared)](docs/DEPLOYMENT.md)
- [Operations](docs/OPERATIONS.md) (local runs, real BigQuery mode, job recovery, retention, troubleshooting)
- [Roadmap](docs/ROADMAP.md) · [ADRs](docs/adr/) · [Official sources checked](docs/SOURCES.md)

## Configuration

See [`.env.example`](.env.example). Server-only values never use the `NEXT_PUBLIC_` prefix. Never commit
`.env.local`, key files or credential JSON. Real BigQuery mode requires `WAREHOUSE_MODE=bigquery`,
Application Default Credentials and an explicit `BIGQUERY_BILLING_APPROVED=true`.

## License

MIT
