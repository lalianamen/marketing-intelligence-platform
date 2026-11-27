# Architecture

Last updated: 2026-11-23.

## Overview

A modular monolith: one Next.js app (UI + server actions + route handlers), one background worker
process, PostgreSQL (Supabase) for operational state, and an analytical warehouse with one isolated
dataset per company: Google BigQuery in real mode, or a local PostgreSQL-backed simulation in development.

```
 Browser ──HTTPS──▶ Next.js (App Router)
                     │  proxy.ts: session refresh, /app protection
                     │  Server Components: reads via Supabase (user JWT, RLS enforced)
                     │  Server actions/route handlers: RPCs (RLS + checks) or privileged pool
                     │                                 AFTER server-side authorization
                     ▼
              Supabase Postgres ◀──────────── Worker (Node, tsx)
              (auth, tenancy, registry,        claim jobs (SKIP LOCKED + lease)
               jobs, schedules, audit,         provisioning · syncs · scheduler · reconcile
               encrypted secrets)                   │
                                                    ▼
                                    Warehouse adapter (interface)
                                    ├─ BigQueryWarehouse (official SDK, ADC)
                                    └─ LocalWarehouse (simulated, schema per dataset)
                                                    ▲
                                    Connector adapters: GA4 Data API, Google Ads API,
                                    Simulated (sample), CSV (validated uploads)
```

## Modules (`src/server/*`)

| Module | Responsibility |
|---|---|
| `auth/authz.ts` | Server-side authorization (company read/manage, workspace roles), independent of RLS |
| `appContext.ts`, `supabase/` | Session, workspace bootstrap, company selection (RLS-scoped) |
| `registry/` | Cloud project selector and company → dataset mapping (`cloud_projects`, `analytics_resources`) |
| `provisioning/` | Idempotent dataset creation + reconciliation |
| `warehouse/` | `Warehouse` interface, BigQuery and local adapters, dataset IDs, error mapping |
| `connectors/` | Common connector contract, GA4, Google Ads, simulated, OAuth helpers |
| `ingestion/` | CSV validation, upload storage, normalization (versioned mapping) |
| `sync/` | Sync windows/checkpoints and the shared sync engine |
| `scheduling/` | Central daily scheduler (one loop for all tenants) |
| `jobs/` | Durable Postgres queue: claim, lease, fencing, backoff, lease recovery |
| `metrics/` + `src/lib/kpi.ts` | Dashboard query service, KPI engine |
| `reporting/` | CSV export |
| `usage/` | Usage events and cost estimates |
| `src/worker/` | Worker loop, `drain()` for tests/one-shot runs |

## Data flow — "add company"

1. Server action → RPC `create_company` (SECURITY DEFINER; checks role, timezone, rate limit and company cap) inserts the company, its settings, a `provisioning_jobs` row and an audit row in one transaction.
2. UI shows *Pending* and refreshes automatically.
3. Worker claims the job → `selectCloudProject` → inserts `analytics_resources` (status `preparing`, deterministic `dataset_id`) → `ensureDataset` (409 = exists) → verifies labels (`mip_company`, `mip_workspace`) → `ensureSchema` → marks `ready`, increments `dataset_count` once.
4. Crash anywhere → lease expires → `recoverExpiredLeases` re-queues the job → steps are idempotent.

## Data flow — sync

`sync_runs` is the queue. Triggers: central scheduler (`sync_schedules.next_run_at`), *Update now* /
backfill (`request_sync`), CSV import (`queue_csv_import`). The engine:
fetch window → RAW insert (idempotent `record_id`) → normalize → MERGE/upsert on grain →
rebuild MART for touched dates → coverage and quality checks → checkpoint and freshness →
usage events. A run that is incomplete (pagination limit) fails and is retried; the cursor only advances after success.

## Choice rationale (summary; details in `docs/adr/`)

- **Modular monolith**: one deployable, clear module seams, no premature network boundaries (ADR-0004).
- **Dataset per company** (ADR-0002): hard isolation boundary, simple deletion/export per tenant, per-dataset IAM later. Datasets are created per *company*, never per sign-up.
- **Registry + project selector** (ADR-0003): no project ID in business logic; projects can be added later.
- **Postgres queue** (ADR-0004): durable, transactional with domain writes, zero extra infrastructure; portable to Cloud Tasks/Cloud Run because domain functions (`provisionCompanyDataset`, `processSyncRun`) don't know how they were triggered.
- **Daily grain model, conversions never blended** (ADR-0005).
- **Local simulated warehouse**: lets the whole product run and be tested at $0 without a Google account; clearly labelled.

## Extension points (not implemented)

- New connector: implement `Connector` in `src/server/connectors`, add a `connector_providers` row; the sync engine, scheduling and UI status already work.
- Future AI / external tools: must call an authorized, scoped API on top of `getDashboardData`-style services (company-scoped, bounded), never raw warehouse SQL.
- Billing/Stripe: `workspaces.plan`, `max_companies` and `usage_events` are the hooks for limits and metering.
- Team members/client viewers: `workspace_members` roles and `company_members` (`company_admin`, `company_viewer`) are covered by RLS tests. **Users** (Account settings → Users, owner/admin only): invite an email as
  Viewer (`company_viewer`, read only) or Editor (`company_admin`: connect sources, upload, company settings; no delete, no
  inviting) for ticked companies. Invitations live in `company_invitations` (RLS on, no policies: server only); the
  invited person signs up or logs in with that email and `accept_my_invitations()` (SECURITY DEFINER, verified email
  only) adds the `company_members` rows on the next app visit. An address that already has a verified account gets
  access at once. Server checks: `src/server/team/team.ts` (`requireWorkspaceRole` owner/admin), pages for changes use
  `getManageContext()` (viewers are sent back).
- Cloud Tasks/Cloud Run: replace `claimJob` polling with push delivery calling the same domain functions.
