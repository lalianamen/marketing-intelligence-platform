# Costs

Last updated: 2026-11-23. Prices and allowances were read from official pages on that date (links in
`docs/SOURCES.md`). Re-check them before making decisions. **Nothing here is a guarantee that usage is free.**

## Phase 1 as delivered

| Item | Cost observed in this build |
|---|---|
| Local development (Supabase CLI in Docker, local simulated warehouse, Mailpit) | $0. No cloud resource was created |
| BigQuery | Not used. No project, dataset or query was created/run during development |
| Google APIs (GA4, Ads) | Not called. Live connectors were tested only against mocked HTTP |
| Hosting | None (not deployed by decision) |

## BigQuery facts that matter

- Free tier: first **10 GiB storage** and first **1 TiB query processing** per month. The pricing page says pricing
  applies to **accounts, not individual projects**, so the allowance is shared across all tenants and
  projects on the billing account. It does **not** reset per subscriber or per dataset.
- After the free tier, on-demand queries in the US multi-region cost **$6.25 per TiB**. Logical storage costs **$0.02/GiB-month** active
  and $0.01 long-term (US multi-region; other regions differ).
- The **Sandbox** needs no billing account, but tables/partitions **expire after 60 days** and it has **no DML**. This app
  uses MERGE/DELETE, so the sandbox is not a viable home for durable history. Real mode requires a
  billing-enabled project.
- **Budgets/alerts do not cap spending.** Google now also documents "spend cap budgets" for eligible
  services on a project, which pause those services when enforced. Whether BigQuery is eligible in your setup is **not verified**.

## Safeguards in code

| Safeguard | Where |
|---|---|
| Explicit opt-in: no dataset is created unless `BIGQUERY_BILLING_APPROVED=true` | `BigQueryWarehouse.ensureDataset`, `provisionCompanyDataset` |
| `maximumBytesBilled` on **every** query (default 100 MiB, `BIGQUERY_MAX_BYTES_BILLED`); queries over it fail without charge | `BigQueryWarehouse.run` |
| Tables partitioned by date and clustered; every query filters the partition column | `schemaDdl`, all queries |
| Dashboard reads a small daily MART, not RAW history | `getDashboardData` |
| Date range capped at 400 days | `resolveRange` |
| Datasets only per company, never per sign-up; per-workspace company cap; per-project dataset capacity | `create_company`, `cloud_projects` |
| Usage attribution: rows written, API calls, job runs, query bytes processed/billed per workspace/company | `usage_events` |
| Estimated vs actual cost kept apart: every stored cost is `is_estimate=true`, computed at list price, free tier not subtracted | `src/server/usage/usage.ts`, Settings → Advanced |

## Not built (documented plan)

1. **Cloud Billing export to BigQuery** (standard + detailed usage) for reconciliation. Join on the dataset labels
   (`mip_company`, `mip_workspace`) and the job label `mip_component` to attribute actual cost per tenant.
2. **Tiered limits**: per plan, cap companies, connections, sync frequency, history depth, and monthly bytes
   billed per workspace (sum of `usage_events.bytes_billed`), and refuse expensive work at admission time.
3. **Overages / hard budget policy**: application-level stop for a workspace, plus a project-level spend cap
   where eligible. Some charges, such as storage and already-running jobs, can't be stopped instantly by application limits.
4. Per-provider costs: Google Ads API and GA4 Data API are quota-limited (see `docs/SOURCES.md`). GA4
   streaming export is billed. Third-party APIs (Semrush etc.) need their own paid plans.

## Supabase

The Free plan has a 500 MB database and 2 active projects, and projects pause after 1 week of inactivity. This build used only the local
CLI stack ($0). Operational tables are small; analytical rows live in the warehouse. The local
simulated warehouse is for development only.
