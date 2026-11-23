# Threats, risks and cost risks

Last updated: 2026-11-23. Mitigation details: `docs/SECURITY.md`, `docs/COSTS.md`.

## Threats

| Threat | Mitigation | Tested |
|---|---|---|
| User reads another tenant's data via API with a forged id | RLS on every table, same "not found" for foreign/missing, server-side authz | yes |
| User escalates own role / joins a workspace | no direct writes to `workspace_members`; column-level update grants | yes |
| Moving a company to another workspace | `workspace_id` not updatable; composite FKs | yes |
| Browser chooses dataset/project/SQL | registry-only resolution; identifier validation; parameters | yes (unit) |
| Provisioning adopts someone else's dataset | label check `mip_company`/`mip_workspace` | yes |
| Token theft from DB dump | AES-256-GCM with AAD; key outside DB; table unreachable via API | yes (unit + RLS) |
| OAuth CSRF / code injection | single-use hashed state bound to user + PKCE + scope check | code review only (no live OAuth) |
| Secrets committed to public repo / shipped to browser | git-ignore, scanners, gitleaks in CI | yes (scanners) |
| CSV abuse (huge, binary, malformed) | size/row/column/cell limits, strict parsing | yes |
| Spreadsheet formula injection in exports | prefix `'` | yes |
| Credential stuffing / sign-up spam | Supabase Auth limits + app rate limits; email verification | partially (company rate limit tested; IP limits not load-tested) |
| Open redirect after login | relative `next` only, base `APP_URL` | code review |
| Logs leaking tokens | `redact()` | yes (unit) |

## Reliability risks

| Risk | Mitigation |
|---|---|
| Worker crash mid-job | leases, fencing, lease recovery, idempotent steps (tested) |
| Duplicate jobs / double counting | one active provisioning job per company; idempotency keys; MERGE by grain (tested) |
| Provider returns partial data | completeness check fails the run; coverage gaps recorded (tested) |
| Late-arriving data | lookback re-fetch + preliminary status (tested with simulation) |
| Provider quota exhaustion | backoff; per-provider concurrency cap; daily-quota errors not hammered (tested) |

## BigQuery-specific risks

- **Quotas are per project.** Many datasets in one project share query, DML and API quotas. Mitigation: registry with
  capacity per project (`max_datasets`) and a selector that can place new companies in additional projects (ADR-0003).
- **Dataset proliferation.** Dataset count grows with companies, so admin tooling must filter by labels. Tables per dataset are fixed (4).
- **Location is immutable.** Choose per project. Moving a tenant means copy + re-point the registry (future tooling).
- **IAM sprawl.** Prefer dataset-level grants for the service account; humans get no standing access.
- **Cost surprises.** Unbounded queries are prevented by `maximumBytesBilled` + partition filters. Storage grows with history.
  Budgets alert but don't cap.
- **Sandbox misuse.** Not suitable (60-day expiry, no DML).

## Cost risks

| Risk | Status |
|---|---|
| Accidental dataset creation in a billed project | blocked unless `BIGQUERY_BILLING_APPROVED=true` |
| Expensive dashboard query | MART + partition filter + 400-day cap + bytes cap |
| Free tier assumed per tenant | documented as shared at billing-account level; estimates don't subtract it |
| Streaming inserts cost | not used (DML MERGE via query jobs) |
| Paid third-party APIs | none called in Phase 1 |
