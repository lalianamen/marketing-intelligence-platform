# ADR-0003: Multi-project readiness

Status: accepted · 2026-11-23

## Context
BigQuery quotas (API, DML, concurrency) are per project, and the free allowance is per billing account. One project can't hold unlimited tenants.

## Decision
No project id in business logic. `cloud_projects` registers projects with location, status and capacity
(`max_datasets`, `dataset_count`). `selectCloudProject(provider)` chooses where a new company lives, and
`analytics_resources` records the result. Every warehouse call takes a `DatasetRef` from the registry.
Phase 1 registers one administrator-configured project (or `local`).

## Future
Placement policies (region per workspace, dedicated project for large agencies, spill-over when full),
tenant migration tooling (copy dataset, verify, switch the registry row), and project-level budgets.
