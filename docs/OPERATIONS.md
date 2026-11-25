# Operations (local)

Last updated: 2026-11-23.

## Prerequisites

Node 22+, Docker (for the Supabase CLI), ~4 GB free disk for images.

## First run

```bash
npm ci
npm run db:start          # local Supabase: Postgres, Auth, Mailpit (applies migrations)
npm run env:local         # writes git-ignored .env.local from `supabase status` + a random encryption key
npm run dev               # http://127.0.0.1:3000
npm run worker            # second terminal: background worker (provisioning, syncs, scheduler)
```

Confirmation and reset emails are captured by **Mailpit**: http://127.0.0.1:54324 (nothing is sent).

The Supabase CLI pulls images from a container registry. In environments where the default registry is blocked,
`SUPABASE_INTERNAL_IMAGE_REGISTRY=docker.io npx supabase start` worked during development.

## Tests

```bash
npm run typecheck
npm test                    # unit (no services needed)
npm run test:integration    # needs db:start + env:local
npm run build && npm run test:e2e   # browser journey; starts next + worker itself; port 3000 must be free
npm run check:secrets && npm run check:bundle
```

## Real BigQuery mode (only with approval)

1. A dedicated **dev** project with billing approved by the owner. Pick the location once.
2. `gcloud auth application-default login` (local ADC), or run as a least-privilege service account. Never put a key file in the repo.
3. In `.env.local`: `WAREHOUSE_MODE=bigquery`, `BIGQUERY_PROJECT_ID=…`, `BIGQUERY_LOCATION=US`, `BIGQUERY_BILLING_APPROVED=true`,
   `DATASET_PREFIX=mip_dev`, optionally a lower `BIGQUERY_MAX_BYTES_BILLED`.
4. Restart the worker. It registers the project in `cloud_projects`. New companies get datasets in that project.

Companies provisioned while in local mode stay mapped to the local warehouse (the registry records the
provider per company). Migrating them is a future, explicit operation.

## Job recovery

| Situation | What happens | Manual action |
|---|---|---|
| Worker crashed mid-job | Lease (`locked_until`) expires; maintenance (every 30 s) re-queues it; the attempt is marked `abandoned` | none |
| Retryable error (timeout, quota, rate limit, 5xx) | `run_after = now + backoff` (exponential, full jitter, cap 1 h) | none |
| Attempts exhausted | status `dead`; resource/connection marked failed; UI shows Retry / Update now | Companies → Retry, or Connections → Update now |
| Non-retryable (permission, owner mismatch, billing not approved) | `failed` with `last_error_code` | fix the cause, then Retry |
| Company without dataset and without job | `reconcileProvisioning` creates a job | none |

Inspect: `select status, attempts, last_error_code, last_error from provisioning_jobs order by created_at desc;`,
`select * from job_attempts where job_id = '…';`, `select status, error_code, window_start, window_end from sync_runs …`.
Worker logs are JSON lines with `job_id` / `sync_run_id` / `company_id`.

## Scheduling

The worker's maintenance loop calls `enqueueDueSyncs` for **all** tenants: due `sync_schedules` →
`sync_runs` (idempotent per slot, skipped if a run is active), then `next_run_at` = next local time + provider
buffer (GA4 60 min, Ads 30 min) + 0–15 min deterministic jitter. At most 4 concurrent runs per provider, one per connection.

## Retention

- The warehouse keeps full history. Syncs MERGE by grain and never truncate to a rolling window.
- Local simulated warehouse: one schema per dataset in database `mip_warehouse`.
- **No automatic deletion** on user deletion, failed provisioning, disconnect or plan change.
- **Clear all data (manual, owner/admin only)** — Settings → "Clear all data", typed-name confirmation. The
  `clear_company_data` RPC removes connections (stored tokens, schedules, runs, checkpoints), CSV uploads, data checks
  and pending sign-ins and queues a `clear_data` job; the worker verifies the dataset labels and empties
  `raw_records`, `norm_campaign_daily` and `mart_daily_source`. The company, its settings and its dataset stay.
  Refused while the dataset is being prepared, another job is queued or an import is running.
- **Company deletion (manual, owner/admin only)** — Settings → "Delete company", confirmed by typing the company name.
  1. `delete_company` RPC: marks the company `deleting` (hidden from the app; `can_manage_company` is false, so no new
     syncs, uploads or edits), cancels queued runs, disables schedules, deletes stored OAuth tokens, writes
     `company.deletion_requested` to `audit_logs`, queues a `provisioning_jobs` row with `kind = 'delete_dataset'`.
     Refused with "busy" while the dataset is still being created.
  2. Worker (`src/server/provisioning/deprovision.ts`): waits while a sync for the company is running, checks that the
     dataset labels name this company (never drops another tenant's dataset; a mismatch fails the job for manual
     review), drops the dataset (BigQuery `delete({ force: true })`, local `drop schema … cascade`), deletes the registry
     row, decrements `cloud_projects.dataset_count`, writes `company.deleted`, deletes the company row (cascades to
     connections, uploads, runs, settings, jobs).
  3. Maintenance re-queues companies stuck in `deleting` for more than 10 minutes, except label mismatches.
  There is no grace period and no export step: deletion is immediate and cannot be undone. `audit_logs` and
  `usage_events` keep `company_id` (no foreign key) as the deletion record.
- `csv_uploads.rows` holds validated rows only until the import: they are emptied once imported or failed, and after
  7 days for files never imported. The numbers live only in the warehouse; the app database keeps file name, size,
  hash, row count and summary.

## Troubleshooting

| Symptom | Check |
|---|---|
| Company stuck on *Pending* | Is the worker running? `npm run worker` |
| Email link says invalid | Links are single-use and expire after 1 h; request a new one |
| "Live connection is not set up yet" | Google OAuth env vars are missing (admin task; see CONNECTORS.md) |
| Connection "Needs reconnecting" | Refresh token expired or revoked (7-day expiry for OAuth apps in Testing) |
| BigQuery error `bytes_limit_exceeded` | Raise `BIGQUERY_MAX_BYTES_BILLED` carefully or narrow the date range |
| Provisioning `billing_not_approved` | Intended safeguard; set `BIGQUERY_BILLING_APPROVED=true` only after owner approval |

## Scheduler

- Due daily syncs are enqueued by maintenance inside `/api/jobs/run` (protected by `CRON_SECRET`).
- Vercel Hobby cron calls it once a day (`vercel.json`, 16:00 UTC). The GitHub Actions workflow
  `.github/workflows/scheduler.yml` calls it hourly (minute 7) when the repository secret `CRON_SECRET` is set to the
  same value as in Vercel, so a connector's chosen local time is honoured to within about an hour.
- Without the hourly trigger, scheduled updates run only at the daily cron.
- An API sync replaces its window: the connector's normalized rows for those days are deleted and rewritten, so
  campaigns the provider no longer returns do not remain and double count.

