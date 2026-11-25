-- Per-connector options chosen by the user, e.g. {"ga4_reports": ["traffic_sources", "geo"]}.
-- Written only by the server after an access check (no direct grant to authenticated).
alter table public.company_connections
  add column settings jsonb not null default '{}'::jsonb
  check (jsonb_typeof(settings) = 'object' and pg_column_size(settings) <= 8192);
