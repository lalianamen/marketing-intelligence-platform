-- Marketing Intelligence Platform — Phase 1 core operational schema.
-- Operational metadata only. Analytical data lives in the warehouse
-- (BigQuery dataset per company, or the local simulated warehouse).
--
-- Conventions:
--   * UUID primary keys, never display names or emails as identifiers.
--   * Every tenant-owned row carries workspace_id AND company_id; composite
--     foreign keys (company_id, workspace_id) -> companies(id, workspace_id)
--     make it impossible to attach a row to a company of another workspace.
--   * Helper functions live in schema "private" (not exposed through the API).
--   * Users never write job/registry tables directly; they call narrow
--     SECURITY DEFINER RPCs that re-check authorization.

create extension if not exists pgcrypto with schema extensions;

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
grant usage on schema private to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Identity & tenancy
-- ---------------------------------------------------------------------------

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text check (char_length(display_name) <= 120),
  default_workspace_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 120),
  created_by uuid not null references auth.users (id),
  plan text not null default 'free' check (plan in ('free')),
  max_companies integer not null default 25 check (max_companies between 0 and 10000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One automatically created workspace per user (idempotent onboarding).
create unique index workspaces_one_bootstrap_per_user on public.workspaces (created_by);

alter table public.profiles
  add constraint profiles_default_workspace_fk
  foreign key (default_workspace_id) references public.workspaces (id) on delete set null;

create table public.workspace_members (
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  -- owner/admin/member now; more roles may be added later.
  role text not null check (role in ('owner', 'admin', 'member')),
  created_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);
create index workspace_members_user_idx on public.workspace_members (user_id);

create table public.companies (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete restrict,
  name text not null check (char_length(btrim(name)) between 1 and 160),
  website text check (website is null or char_length(website) <= 300),
  industry text check (industry is null or char_length(industry) <= 120),
  country text check (country is null or country ~ '^[A-Z]{2}$'),
  timezone text not null default 'UTC' check (char_length(timezone) <= 64),
  status text not null default 'active' check (status in ('active', 'archived')),
  created_by uuid not null references auth.users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, workspace_id)
);
create index companies_workspace_idx on public.companies (workspace_id);

-- Future collaborators / client viewers scoped to a single company.
create table public.company_members (
  company_id uuid not null,
  workspace_id uuid not null,
  user_id uuid not null references auth.users (id) on delete cascade,
  role text not null check (role in ('company_admin', 'company_viewer')),
  created_at timestamptz not null default now(),
  primary key (company_id, user_id),
  foreign key (company_id, workspace_id) references public.companies (id, workspace_id) on delete cascade
);
create index company_members_user_idx on public.company_members (user_id);

create table public.company_settings (
  company_id uuid primary key,
  workspace_id uuid not null,
  sync_local_time time not null default '06:00',
  reporting_currency text check (reporting_currency is null or reporting_currency ~ '^[A-Z]{3}$'),
  updated_at timestamptz not null default now(),
  foreign key (company_id, workspace_id) references public.companies (id, workspace_id) on delete cascade
);

-- ---------------------------------------------------------------------------
-- Resource registry (cloud projects and per-company analytics datasets)
-- ---------------------------------------------------------------------------

create table public.cloud_projects (
  id uuid primary key default gen_random_uuid(),
  provider text not null check (provider in ('bigquery', 'local')),
  project_id text not null check (char_length(project_id) between 1 and 128),
  location text not null check (char_length(location) between 1 and 64),
  status text not null default 'active' check (status in ('active', 'full', 'disabled')),
  max_datasets integer not null default 500 check (max_datasets > 0),
  dataset_count integer not null default 0 check (dataset_count >= 0),
  is_default boolean not null default false,
  created_at timestamptz not null default now(),
  unique (provider, project_id)
);

create table public.analytics_resources (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  company_id uuid not null,
  provider text not null check (provider in ('bigquery', 'local')),
  cloud_project_id uuid not null references public.cloud_projects (id),
  project_id text not null,
  dataset_id text not null check (dataset_id ~ '^[A-Za-z0-9_]+$' and char_length(dataset_id) <= 1024),
  location text not null,
  status text not null default 'preparing' check (status in ('preparing', 'ready', 'failed')),
  schema_version integer not null default 0,
  is_simulated boolean not null,
  verified_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id),
  unique (provider, project_id, dataset_id),
  foreign key (company_id, workspace_id) references public.companies (id, workspace_id) on delete restrict
);

-- ---------------------------------------------------------------------------
-- Connectors
-- ---------------------------------------------------------------------------

create table public.connector_providers (
  id text primary key check (id ~ '^[a-z0-9_]{2,40}$'),
  display_name text not null,
  category text not null check (category in ('analytics', 'advertising', 'file', 'crm', 'commerce', 'cms', 'reviews', 'telephony', 'seo', 'behavior')),
  availability text not null check (availability in ('available', 'requires_admin_setup', 'requires_partner_access', 'planned')),
  supports_oauth boolean not null default false,
  supports_simulation boolean not null default false,
  default_lookback_days integer not null default 3,
  finalization_days integer not null default 3,
  description text not null
);

create table public.company_connections (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  company_id uuid not null,
  provider_id text not null references public.connector_providers (id),
  -- live = real provider API; simulated = deterministic sample data, never shown as real;
  -- manual = CSV uploads.
  mode text not null check (mode in ('live', 'simulated', 'manual')),
  status text not null default 'not_connected' check (status in (
    'not_connected', 'pending_authorization', 'connected', 'error', 'expired', 'disconnected')),
  external_account_id text check (external_account_id is null or char_length(external_account_id) <= 128),
  external_account_name text check (external_account_name is null or char_length(external_account_name) <= 200),
  scopes text[] not null default '{}',
  last_synced_at timestamptz,
  data_as_of date,
  last_error text,
  consecutive_failures integer not null default 0,
  created_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, company_id),
  foreign key (company_id, workspace_id) references public.companies (id, workspace_id) on delete cascade
);
create unique index company_connections_unique_account
  on public.company_connections (company_id, provider_id, mode, coalesce(external_account_id, ''));
create index company_connections_company_idx on public.company_connections (company_id);

-- Encrypted provider credentials. RLS enabled with NO policies: unreachable
-- for anon/authenticated; only the server (service role) reads it.
create table public.connection_secrets (
  connection_id uuid primary key references public.company_connections (id) on delete cascade,
  workspace_id uuid not null,
  company_id uuid not null,
  ciphertext text not null,
  key_version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- OAuth state (CSRF protection), single use, short lived. Server only.
create table public.oauth_states (
  id uuid primary key default gen_random_uuid(),
  state_hash text not null unique,
  user_id uuid not null references auth.users (id) on delete cascade,
  workspace_id uuid not null,
  company_id uuid not null,
  provider_id text not null references public.connector_providers (id),
  code_verifier_ciphertext text not null,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now(),
  foreign key (company_id, workspace_id) references public.companies (id, workspace_id) on delete cascade
);

-- ---------------------------------------------------------------------------
-- Scheduling, sync runs, checkpoints, CSV uploads
-- ---------------------------------------------------------------------------

create table public.sync_schedules (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  company_id uuid not null,
  connection_id uuid not null unique,
  frequency text not null default 'daily' check (frequency in ('daily', 'manual')),
  local_time time not null default '06:00',
  timezone text not null,
  buffer_minutes integer not null default 0 check (buffer_minutes between 0 and 1440),
  enabled boolean not null default true,
  next_run_at timestamptz,
  last_enqueued_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (connection_id, company_id) references public.company_connections (id, company_id) on delete cascade,
  foreign key (company_id, workspace_id) references public.companies (id, workspace_id) on delete cascade
);
create index sync_schedules_due_idx on public.sync_schedules (next_run_at) where enabled;

create table public.csv_uploads (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  company_id uuid not null,
  uploaded_by uuid not null references auth.users (id),
  filename text not null check (char_length(filename) <= 255),
  byte_size integer not null check (byte_size between 1 and 5242880),
  row_count integer not null check (row_count between 1 and 50000),
  content_sha256 text not null check (content_sha256 ~ '^[0-9a-f]{64}$'),
  -- Validated, typed rows (server-validated; never trusted from the browser).
  rows jsonb not null,
  summary jsonb not null default '{}',
  status text not null default 'validated' check (status in ('validated', 'queued', 'imported', 'failed')),
  created_at timestamptz not null default now(),
  unique (company_id, content_sha256),
  unique (id, company_id),
  foreign key (company_id, workspace_id) references public.companies (id, workspace_id) on delete cascade
);

create table public.sync_runs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  company_id uuid not null,
  connection_id uuid not null,
  provider_id text not null references public.connector_providers (id),
  trigger text not null check (trigger in ('scheduled', 'manual', 'csv_upload', 'backfill', 'retry')),
  status text not null default 'queued' check (status in ('queued', 'running', 'succeeded', 'failed', 'dead', 'cancelled')),
  window_start date,
  window_end date,
  csv_upload_id uuid,
  idempotency_key text not null unique,
  attempts integer not null default 0,
  max_attempts integer not null default 5,
  run_after timestamptz not null default now(),
  locked_by text,
  locked_until timestamptz,
  rows_read integer not null default 0,
  rows_written integer not null default 0,
  is_simulated boolean not null default false,
  error_code text,
  error_message text,
  created_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  check (window_start is null or window_end is null or window_start <= window_end),
  foreign key (connection_id, company_id) references public.company_connections (id, company_id) on delete cascade,
  foreign key (csv_upload_id, company_id) references public.csv_uploads (id, company_id),
  foreign key (company_id, workspace_id) references public.companies (id, workspace_id) on delete cascade
);
create index sync_runs_claim_idx on public.sync_runs (run_after) where status = 'queued';
create index sync_runs_company_idx on public.sync_runs (company_id, created_at desc);

create table public.sync_checkpoints (
  connection_id uuid primary key,
  workspace_id uuid not null,
  company_id uuid not null,
  cursor_date date,
  cursor jsonb not null default '{}',
  last_sync_run_id uuid references public.sync_runs (id) on delete set null,
  updated_at timestamptz not null default now(),
  foreign key (connection_id, company_id) references public.company_connections (id, company_id) on delete cascade,
  foreign key (company_id, workspace_id) references public.companies (id, workspace_id) on delete cascade
);

-- ---------------------------------------------------------------------------
-- Provisioning jobs & attempts
-- ---------------------------------------------------------------------------

create table public.provisioning_jobs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  company_id uuid not null,
  kind text not null default 'create_dataset' check (kind in ('create_dataset')),
  status text not null default 'queued' check (status in ('queued', 'running', 'succeeded', 'failed', 'dead')),
  idempotency_key text not null unique,
  attempts integer not null default 0,
  max_attempts integer not null default 6,
  run_after timestamptz not null default now(),
  locked_by text,
  locked_until timestamptz,
  last_error_code text,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  finished_at timestamptz,
  foreign key (company_id, workspace_id) references public.companies (id, workspace_id) on delete cascade
);
create index provisioning_jobs_claim_idx on public.provisioning_jobs (run_after) where status = 'queued';
-- At most one active (queued/running) provisioning job per company.
create unique index provisioning_jobs_one_active
  on public.provisioning_jobs (company_id) where status in ('queued', 'running');

create table public.job_attempts (
  id bigint generated always as identity primary key,
  job_type text not null check (job_type in ('provisioning', 'sync')),
  job_id uuid not null,
  workspace_id uuid not null,
  company_id uuid not null,
  attempt integer not null,
  worker_id text not null,
  status text not null check (status in ('running', 'succeeded', 'failed', 'abandoned')),
  error_code text,
  error_message text,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  foreign key (company_id, workspace_id) references public.companies (id, workspace_id) on delete cascade
);
create index job_attempts_job_idx on public.job_attempts (job_type, job_id);

-- ---------------------------------------------------------------------------
-- Data quality, metrics catalog, usage, audit, rate limiting
-- ---------------------------------------------------------------------------

create table public.data_quality_issues (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  company_id uuid not null,
  connection_id uuid,
  sync_run_id uuid references public.sync_runs (id) on delete set null,
  severity text not null check (severity in ('info', 'warning', 'error')),
  code text not null,
  message text not null,
  details jsonb not null default '{}',
  metric_date date,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  foreign key (company_id, workspace_id) references public.companies (id, workspace_id) on delete cascade
);
create index data_quality_company_idx on public.data_quality_issues (company_id, created_at desc);

create table public.metric_definitions (
  key text primary key,
  name text not null,
  formula text not null,
  unit text not null check (unit in ('currency', 'percent', 'ratio', 'count')),
  requires text[] not null,
  description text not null
);

create table public.usage_events (
  id bigint generated always as identity primary key,
  workspace_id uuid not null,
  company_id uuid,
  kind text not null check (kind in (
    'warehouse_query', 'warehouse_rows_written', 'provider_api_call', 'job_run', 'storage_snapshot')),
  quantity numeric not null default 0,
  unit text not null,
  bytes_processed bigint,
  bytes_billed bigint,
  estimated_cost_usd numeric(14, 6),
  -- Estimates are never presented as billed cost; billed cost comes only from
  -- Cloud Billing export reconciliation (future).
  is_estimate boolean not null default true,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now(),
  foreign key (workspace_id) references public.workspaces (id) on delete cascade
);
create index usage_events_ws_idx on public.usage_events (workspace_id, created_at desc);

create table public.audit_logs (
  id bigint generated always as identity primary key,
  workspace_id uuid references public.workspaces (id) on delete cascade,
  company_id uuid,
  actor_user_id uuid,
  actor_type text not null default 'user' check (actor_type in ('user', 'worker', 'system')),
  action text not null,
  target_type text,
  target_id text,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create index audit_logs_ws_idx on public.audit_logs (workspace_id, created_at desc);

create table private.rate_limit_counters (
  bucket text not null,
  window_start timestamptz not null,
  hits integer not null default 0,
  primary key (bucket, window_start)
);
