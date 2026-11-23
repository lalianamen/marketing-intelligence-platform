# ADR-0001: Tenant isolation model

Status: accepted · 2026-11-23

## Context
Agencies manage many companies; one owner must never see another's data, and a client viewer must see
only one company. Data lives in two systems (Postgres and the warehouse), and Supabase RLS covers only Postgres.

## Decision
Hierarchy: Platform → Workspace → Company → Connection → Analytics resource.
- Postgres: RLS on every table. Writes through SECURITY DEFINER RPCs that re-check `auth.uid()`.
  Composite FKs `(company_id, workspace_id)`. Column-level update grants.
- Server: `requireCompanyAccess` before any privileged DB or warehouse access (defence in depth).
- Warehouse: physical isolation (a dataset per company, ADR-0002), resolved only via the registry, with tenant labels verified.
- Roles: workspace `owner/admin/member`, company `company_admin/company_viewer`.

## Consequences
Two independent checks must both pass. Cross-tenant tests are part of the suite. Adding a table requires adding RLS policies.
