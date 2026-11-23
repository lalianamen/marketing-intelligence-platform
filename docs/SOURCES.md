# Official sources checked

Last checked: 2026-11-23. Each fact was read from the official page linked next to it.
Re-check these pages before you make a pricing or access decision: providers change their
terms, quotas and prices often. Items marked **NOT VERIFIED** were not confirmed on an
official page, and the code does not depend on them.

## BigQuery

| Fact | Source |
|---|---|
| Free tier: first 10 GiB storage per month and first 1 TiB of query data processed per month. Pricing models apply to *accounts*, not individual projects, unless otherwise specified (the price table is labelled "per 1 month / account"). | https://cloud.google.com/bigquery/pricing |
| On-demand query price, US multi-region: $6.25 per TiB after the free 1 TiB. | https://cloud.google.com/bigquery/pricing |
| Logical storage, US multi-region: active $0.02 per GiB-month, long-term $0.01 per GiB-month (region-specific prices differ, e.g. us-central1). | https://cloud.google.com/bigquery/pricing |
| Sandbox: no billing account needed; tables, views and partitions expire after 60 days by default; no streaming writes, DML or Data Transfer Service; 10 GiB lifetime storage limit. | https://docs.cloud.google.com/bigquery/docs/sandbox |
| Dataset names: up to 1,024 characters; letters, numbers and underscores only; unique per project; case-sensitive by default. | https://docs.cloud.google.com/bigquery/docs/datasets |
| Dataset location can only be set at creation time. | https://docs.cloud.google.com/bigquery/docs/datasets |
| Maximum bytes billed: if the estimate exceeds the limit, the query fails without incurring a charge (for clustered tables the estimate is an upper bound). | https://docs.cloud.google.com/bigquery/docs/best-practices-costs |
| Error `duplicate` → HTTP 409 when creating a dataset/table/job that already exists. | https://docs.cloud.google.com/bigquery/docs/errors |
| Node.js client: `@google-cloud/bigquery`. | https://docs.cloud.google.com/bigquery/docs/reference/libraries |
| Application Default Credentials. | https://docs.cloud.google.com/docs/authentication/application-default-credentials |

## Google Analytics 4

| Fact | Source |
|---|---|
| BigQuery export: needs Editor+ on the GA property, OWNER on the BigQuery project, BigQuery API enabled; link under Admin > Product Links > BigQuery Links. | https://support.google.com/analytics/answer/9823238 |
| Standard properties: daily BigQuery export limit of 1 million events. Streaming export is best-effort (no completeness SLO) and is charged. Daily tables usually arrive mid-afternoon in the property time zone, may slip a day, and keep updating for up to 2 days for late events. | https://support.google.com/analytics/answer/9358801 |
| Data API `runReport` scopes: `analytics.readonly` or `analytics`. | https://developers.google.com/analytics/devguides/reporting/data/v1/rest/v1beta/properties/runReport |
| Data API quotas, standard properties: 200,000 core tokens per property per day; 40,000 per property per hour; 14,000 per project per property per hour; 10 concurrent requests. Exhaustion → `429 RESOURCE_EXHAUSTED`. | https://developers.google.com/analytics/devguides/reporting/data/v1/quotas |
| Data API returns "the same report data as the Google Analytics interface". (That the API never returns raw events is **NOT VERIFIED** as an explicit statement; the design treats it as report-level data.) | https://developers.google.com/analytics/devguides/reporting/data/v1 |
| Data freshness, standard properties: intraday 2–6 h, daily 12 h; processing can take 24–48 h. | https://support.google.com/analytics/answer/11198161 |

## Google Ads

| Fact | Source |
|---|---|
| The developer-token page says developer tokens were sunset on 2026-09-09, so a developer token or manager account is no longer needed to start. Access levels now attach to the Google Cloud project, and a token sent in headers is optional and ignored. | https://developers.google.com/google-ads/api/docs/get-started/dev-token |
| Access levels: Test (test accounts only, 15,000 ops/day); Explorer (production accounts at 2,880 ops/day, some features restricted); Basic (15,000 ops/day, brand verification); Standard (unlimited, manual audit). | https://developers.google.com/google-ads/api/docs/api-policy/access-levels |
| OAuth scope `https://www.googleapis.com/auth/adwords`. | https://developers.google.com/google-ads/api/docs/oauth/single-user-authentication |
| `login-customer-id` is required when you access an account through a manager account; omitting it gives `USER_PERMISSION_DENIED`. | https://developers.google.com/google-ads/api/docs/concepts/call-structure |
| Latest API version at the time of checking: v26.2 (2026-11-11). | https://developers.google.com/google-ads/api/docs/release-notes |
| Rate limiting surfaces as `RESOURCE_TEMPORARILY_EXHAUSTED` (QuotaError). | https://developers.google.com/google-ads/api/docs/best-practices/rate-limits |
| BigQuery Data Transfer Service connector for Google Ads exists. | https://docs.cloud.google.com/bigquery/docs/google-ads-transfer |

## Google OAuth

| Fact | Source |
|---|---|
| External apps in "Testing" get refresh tokens that expire in 7 days (unless they only request name/email/profile scopes). | https://developers.google.com/identity/protocols/oauth2 |
| Testing apps: up to 100 test users. | https://support.google.com/cloud/answer/15549945 |
| Sensitive scopes require review by Google. Whether `analytics.readonly` / `adwords` are sensitive or restricted is **NOT VERIFIED**: check the project's Data Access page in Cloud Console. | https://developers.google.com/identity/protocols/oauth2/production-readiness/sensitive-scope-verification |

## Supabase

| Fact | Source |
|---|---|
| RLS; `auth.uid()` returns the requesting user's ID (null when unauthenticated); wrap as `(select auth.uid())` for performance. | https://supabase.com/docs/guides/database/postgres/row-level-security |
| Local development: `supabase init` / `supabase start` (needs a Docker-compatible runtime). | https://supabase.com/docs/guides/local-development |
| Free plan: 500 MB database, 2 active projects, projects paused after 1 week of inactivity, 50,000 MAU, 5 GB egress, 1 GB file storage. | https://supabase.com/pricing |

## Yelp

| Fact | Source |
|---|---|
| Ads API: "Access is not available by default" — request via the Yelp account team. | https://docs.developer.yelp.com/docs/ads-api |
| Partner APIs are reserved for contracted Yelp partners. | https://docs.developer.yelp.com/docs/yelp-partner-apis |
| API terms: no storing content longer than 24 h (business IDs excepted), no own listings database, analysis is non-commercial and aggregate-only, no selling data or use on behalf of third parties, no feeding content to generative AI models. | https://terms.yelp.com/developers/api_terms/ |

## Cloud Billing

| Fact | Source |
|---|---|
| An alerts-only budget does not cap usage or spending. | https://docs.cloud.google.com/billing/docs/how-to/budgets |
| Spend cap budgets exist for eligible services on a project; when enforced, those services pause until the cap is lifted manually. | https://docs.cloud.google.com/billing/docs/how-to/budgets-spend-caps |
| Cloud Billing export to BigQuery (standard, detailed, pricing). | https://docs.cloud.google.com/billing/docs/how-to/export-data-bigquery |

## Next.js

| Fact | Source |
|---|---|
| Next.js 16: the `middleware` file convention is deprecated and renamed to `proxy`. | `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/proxy.md` (bundled with next@16.4.6) |
