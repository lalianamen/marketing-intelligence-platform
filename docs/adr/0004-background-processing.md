# ADR-0004: Background processing

Status: accepted · 2026-11-23

## Decision
A durable **PostgreSQL queue** (`provisioning_jobs`, `sync_runs`) consumed by a separate Node worker:
`FOR UPDATE SKIP LOCKED` claim, lease (`locked_until`) + fencing (`locked_by`), per-attempt log (`job_attempts`),
exponential backoff with jitter, `max_attempts` → `dead` (dead-letter) + manual retry, and a maintenance loop that recovers expired
leases, reconciles companies without datasets, and runs the central scheduler.

## Why
Zero extra infrastructure and $0 locally. Enqueueing happens in the same transaction as the domain write (no lost jobs).
Easy to inspect with SQL.

## Portability
Domain functions (`provisionCompanyDataset`, `processSyncRun`) take a claimed job and don't know the transport.
Moving to Cloud Tasks / Cloud Run means replacing `claimJob` polling with HTTP push to a handler that calls the same
functions. Idempotency keys and fencing remain valid.
