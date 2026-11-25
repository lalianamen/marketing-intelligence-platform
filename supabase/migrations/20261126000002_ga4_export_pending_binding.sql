-- Temporary access of the platform service account that could not be removed right away;
-- the next load of the connector retries the removal (ADR 0006).
alter table public.ga4_export_links add column pending_binding text;
