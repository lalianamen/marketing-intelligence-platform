# Data model

Last updated: 2026-11-23. Source of truth: `supabase/migrations/*.sql` and `src/server/warehouse/bigquery.ts` (`schemaDdl`).

## PostgreSQL (operational)

All tenant-owned tables carry `workspace_id` + `company_id` with a composite FK to
`companies(id, workspace_id)`, so a row can't point to a company of another workspace. UUID keys everywhere.

| Table | Purpose | User access (RLS) |
|---|---|---|
| `profiles` | per-user profile, default workspace | own row; `display_name` updatable |
| `workspaces` | business or agency; `plan`, `max_companies` | members read; owner/admin rename |
| `workspace_members` | `owner` / `admin` / `member` | members read; **no direct writes** |
| `companies` | company; timezone; status | read: member/company member; update of name/website/industry/country/timezone only |
| `company_members` | future client viewers: `company_admin` / `company_viewer` | read |
| `company_settings` | nightly sync time, reporting currency | read; limited update |
| `cloud_projects` | registered projects, capacity (`max_datasets`, `dataset_count`) | **no access** (server only) |
| `analytics_resources` | company → provider/project/dataset/location/status/schema_version/is_simulated | read |
| `connector_providers` | catalog + availability (`available`, `requires_admin_setup`, `requires_partner_access`, `planned`) | read |
| `company_connections` | connection mode (`live`/`simulated`/`manual`), status, freshness (`last_synced_at`, `data_as_of`) | read |
| `connection_secrets` | AES-256-GCM encrypted refresh token | **no access** |
| `oauth_states` | single-use hashed OAuth state + encrypted PKCE verifier | **no access** |
| `sync_schedules` | daily schedule, local time, timezone, buffer, `next_run_at` | read |
| `sync_runs` | sync queue + history (window, attempts, lease, error) | read |
| `sync_checkpoints` | cursor per connection | read |
| `csv_uploads` | validated rows (jsonb), hash, summary | read **without** the `rows` column |
| `provisioning_jobs`, `job_attempts` | provisioning queue and per-attempt log | read |
| `data_quality_issues` | info/warning/error notes per run/date | read |
| `metric_definitions` | KPI catalog | read |
| `usage_events` | usage + **estimated** cost (`is_estimate=true`) | workspace owner/admin |
| `audit_logs` | user/worker actions | workspace owner/admin |
| `private.rate_limit_counters` | fixed-window rate limits | none |

RPCs (all `SECURITY DEFINER`, `search_path=''`, re-check `auth.uid()`): `bootstrap_workspace`,
`create_company`, `retry_provisioning`, `ensure_csv_connection`, `enable_simulated_connection`,
`request_sync`, `queue_csv_import`, `disconnect_connection`.

## Warehouse (per-company dataset)

Dataset id: `<DATASET_PREFIX>_c_<company uuid without dashes>` — deterministic, so retries converge.
Labels: `mip_company`, `mip_workspace`, `mip_env`.

| Layer | Table | Grain | Partition / cluster (BigQuery) |
|---|---|---|---|
| RAW | `raw_records` | one source record per sync run (`record_id`), payload as JSON string, `sync_run_id`, `ingested_at`, `is_simulated`, `schema_version` | `record_date` / `origin, source` |
| NORMALIZED | `norm_campaign_daily` | **date × origin × source × account × campaign** | `metric_date` / `origin, source, campaign_id` |
| MART | `mart_daily_source` | **date × origin × source × currency × is_simulated** | `metric_date` / `origin, source` |
| meta | `_schema_migrations` | applied schema versions | — |

Normalized columns: `impressions`, `clicks`, `spend`, `sessions`, `conversions` + `conversion_type`,
`leads`, `attributed_revenue`, `billed_revenue`, `currency`, `source_timezone`, `data_status`
(`preliminary`/`final`), `is_simulated`, `sync_run_id`, `updated_at`, `row_key`.

Rules:

- **NULL = not available**, 0 = zero. Sums keep NULL when no row has a value.
- `metric_date` is a calendar day in the **source's** reporting timezone (Google Ads account tz, GA4 property tz, company tz for CSV). Daily aggregates are never shifted between timezones.
- `origin` is part of the key, so a CSV row with `source=google_ads` never overwrites API data.
- Re-sync/re-import **replaces** values on the same grain (MERGE / upsert): late-arriving corrections are applied and nothing is double-counted. RAW keeps every version for provenance and re-normalization.
- `data_status = preliminary` while a date is inside the provider's finalization window (GA4 3 days, Google Ads 14 days).
- The dashboard reads only the MART (plus one bounded campaign query on NORMALIZED), always with a date filter on the partition column.

## Metrics

| Metric | Formula | Requires | Notes |
|---|---|---|---|
| CPC | spend / clicks | spend, clicks | same currency |
| CTR | clicks / impressions × 100 | clicks, impressions | |
| CPM | spend / impressions × 1000 | spend, impressions | same currency |
| CPL | spend / leads | spend, leads | only where the source supplies leads (CSV `leads`) |
| Conversion rate | conversions / clicks × 100 | conversions, clicks | denominator is clicks of the same source |
| ROAS | attributed_revenue / spend | both | platform-reported, same source; not billed revenue |
| CAC, ROI | — | customer / profit data | **not computed** in Phase 1 |

Implementation: `src/lib/kpi.ts`. Ratios use **paired sums**: only rows where numerator and
denominator are both present contribute. Status values: `ok`, `not_available`, `zero_denominator`,
`mixed_currency`. Conversions of different sources (`ad_platform_conversion`, `ga4_key_event`,
`csv_conversion`) are shown per source and never summed across sources. Simulated rows never enter
blended totals when real rows exist.
