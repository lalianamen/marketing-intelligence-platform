# Security

Last updated: 2026-11-23.

## Tenant isolation (defence in depth)

1. **RLS on every public table** (`supabase/migrations/…_security_and_rpc.sql`). Users read only rows of
   companies they can access; there are no direct INSERT/DELETE grants for `authenticated`, and UPDATE
   grants are column-level only (for example, `companies.workspace_id` can't be changed).
2. **Narrow SECURITY DEFINER RPCs** for writes. Each one re-derives the caller from `auth.uid()` and
   returns the same "not found" error for a missing resource and a foreign one (no enumeration).
3. **Server-side authorization** (`src/server/auth/authz.ts`) before any use of the privileged DB pool or
   the warehouse, independent of RLS. RLS doesn't protect BigQuery, so warehouse access goes through
   `getDashboardData` → `requireCompanyAccess` → registry lookup.
4. **Composite foreign keys** `(company_id, workspace_id)` stop cross-workspace references at the DB level.
5. **Warehouse resources come only from the registry**: no dataset, project or SQL is accepted from the
   browser. Identifiers are validated (`assertSafeIdentifier`, `assertSafeProjectId`); values are bound parameters.
6. **Datasets carry tenant labels**, and provisioning refuses to adopt a dataset labelled for another tenant.

Tested in `tests/integration/tenancy.test.ts`: cross-tenant reads, forged IDs in every RPC, direct
inserts, tenant moves, role escalation, server-only tables/columns, anonymous access, company_viewer
scope, server-side authorization, the dashboard service and the export route (E2E, forged company → 404).

## Authentication

Supabase Auth with email + password, mandatory email confirmation (`enable_confirmations = true`), and a
minimum of 10 characters with letters and digits. The confirmation and recovery emails use the `token_hash`
flow (`/auth/confirm`). Redirects only go to relative paths and are built from `APP_URL`. Sessions use
`@supabase/ssr` cookies, with `getUser()` (server-validated) on every request in `proxy.ts`. The workspace
is created only after verification and doesn't depend on Google Cloud.

## Secrets

- Nothing secret in the repository: `.env*` (except `.env.example`), key files and credential JSON are git-ignored.
  `npm run check:secrets` scans files git would commit, `npm run check:bundle` scans `.next/static` for
  server values and secret patterns, and CI runs both plus gitleaks.
- The client bundle receives only `NEXT_PUBLIC_SUPABASE_URL` and the publishable anon key.
- Provider refresh tokens are encrypted with **AES-256-GCM** (`TOKEN_ENCRYPTION_KEY`, AAD = connection id)
  and stored in `connection_secrets`, a table with RLS on, no policies and no grants. They're decrypted only inside
  the worker for one API call. Access tokens are never stored.
- Logs and stored error messages go through `redact()` (Bearer, `ya29.`, `1//`, JWTs, `*_secret` fields).
- BigQuery uses **Application Default Credentials**. No key files. In production, use an attached service
  account / workload identity with least privilege (below).

## OAuth (GA4 / Google Ads)

Authorization-code flow with **PKCE (S256)** and a single-use **state** whose SHA-256 is stored with
user, company, provider and a 10-minute expiry. The callback requires the same signed-in user, re-checks
company *manage* access, verifies the granted scope, and requires a refresh token. Users only ever see Google's
own consent screen. Disconnect deletes the stored token and keeps warehouse data.

## Least-privilege IAM (real BigQuery; to be set up by an administrator)

| Identity | Roles (scope) |
|---|---|
| Worker service account | `roles/bigquery.jobUser` (project) + permission to create datasets: `roles/bigquery.user` (project). Use `roles/bigquery.dataEditor` **on each dataset** rather than the project when possible |
| Web app (dashboard queries) | `roles/bigquery.jobUser` (project) + `roles/bigquery.dataViewer` on datasets. Phase 1 uses one identity; splitting read/write identities is recommended before production |
| Humans | no standing dataset access; break-glass via a separate group |

Pick the dataset **location** once (`BIGQUERY_LOCATION`). It can't be changed after creation (see `docs/SOURCES.md`).

## Abuse protection

Rate limits (Postgres fixed window): sign-up 5/h per IP, sign-in 30/5 min per IP, password reset and resend
5/h per IP, company creation 20/h per user, sync requests 30/h per user, OAuth starts 10/h per user. Supabase Auth also
applies its own limits (`[auth.rate_limit]`). There's a per-workspace company cap (`max_companies`, default 25) and
per-project dataset capacity (`cloud_projects.max_datasets`). CSV uploads are limited to 5 MB, 50,000 rows, 30 columns and
300-character cells; binary files are rejected, parsing is strict, and the browser never supplies parsed rows.

## Export safety

Exported text cells that start with `= + - @ TAB CR` get a `'` prefix (spreadsheet formula injection), while numbers stay numeric.

## Privacy, retention, deletion

- Phase 1 stores aggregated marketing metrics only: no call recordings, no personal lead data, no raw GA4 events.
  The CSV template has no personal-data columns. Users are told not to upload personal data.
- Nothing deletes warehouse data automatically: not user deletion, failed provisioning or disconnecting.
- A workspace owner/admin can delete a company (typed-name confirmation). Its dataset is dropped only after its labels
  are verified to name that company; see `docs/OPERATIONS.md#retention`. Account deletion and data export are not built yet.
- Audit log of user and worker actions (`audit_logs`).

## Threat summary

See `docs/THREATS_AND_COSTS.md`.
