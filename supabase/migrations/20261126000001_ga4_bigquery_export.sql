-- GA4 full data through Google's own BigQuery export (ADR 0006).
-- OAuth attempts can now carry a purpose (connect a source, or turn on the export for a connection).
alter table public.oauth_states
  add column purpose text not null default 'connect' check (purpose in ('connect', 'ga4_export')),
  add column connection_id uuid references public.company_connections (id) on delete cascade;

-- One export link per GA4 connection. Server only (RLS on, no policies): read and
-- written through the app's server role after an access check.
create table public.ga4_export_links (
  connection_id uuid primary key references public.company_connections (id) on delete cascade,
  workspace_id uuid not null,
  company_id uuid not null,
  property_id text not null,
  status text not null check (status in ('linking', 'waiting_first_export', 'active', 'failed', 'removed')),
  bq_project text,
  bq_dataset text,
  bq_location text,
  link_name text,
  -- Encrypted refresh token of the Google user who allowed the export (AAD = 'ga4export:<connection_id>').
  -- Kept only to remove the link later; never used to read data.
  grant_ciphertext text,
  first_export_date date,
  last_export_date date,
  key_events text[] not null default '{}',
  error text,
  requested_by uuid references auth.users (id) on delete set null,
  linked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (company_id, workspace_id) references public.companies (id, workspace_id) on delete cascade
);
alter table public.ga4_export_links enable row level security;
revoke all on public.ga4_export_links from anon, authenticated;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'mip_app') then
    grant select, insert, update, delete on public.ga4_export_links to mip_app;
  end if;
end $$;
