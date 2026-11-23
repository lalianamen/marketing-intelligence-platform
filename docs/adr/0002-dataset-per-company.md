# ADR-0002: Dataset per company vs shared tables

Status: accepted · 2026-11-23

## Options
1. **Shared tables** with a `company_id` column (one dataset). Fewer objects and cheap cross-tenant analytics, but isolation
   depends entirely on every query having the right filter. Per-tenant deletion/export means DML on shared tables, and IAM can't be per tenant.
2. **Dataset per company** (chosen). Hard boundary, simple per-tenant delete/export, dataset-level IAM and labels for cost
   attribution. Costs: many datasets per project (quota/admin overhead), and schema migrations must run per dataset.
3. Project per tenant: strongest isolation, but heavy to provision and manage. Kept for very large tenants later (ADR-0003).

## Decision
Dataset per **company**, created only when a company is created (never per sign-up). Deterministic id
`<prefix>_c_<uuid hex>`. Fixed table set (RAW/NORMALIZED/MART) versioned by `_schema_migrations` and `analytics_resources.schema_version`.

## Consequences
Schema upgrades iterate datasets through the worker. Cross-company analytics for agencies needs fan-out queries or a future aggregated mart.
