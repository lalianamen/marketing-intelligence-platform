-- Row Level Security, authorization helpers and the narrow RPC surface.
-- Rule: users read through RLS; users never write job/registry/secret tables
-- directly. Writes go through SECURITY DEFINER functions that re-check
-- authorization from auth.uid() and never trust caller-supplied tenant IDs.

-- ---------------------------------------------------------------------------
-- Helpers (schema private, not exposed through PostgREST)
-- ---------------------------------------------------------------------------

create or replace function private.workspace_role(p_workspace_id uuid)
returns text
language sql stable security definer set search_path = ''
as $$
  select wm.role from public.workspace_members wm
  where wm.workspace_id = p_workspace_id and wm.user_id = (select auth.uid());
$$;

create or replace function private.is_workspace_member(p_workspace_id uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.workspace_members wm
    where wm.workspace_id = p_workspace_id and wm.user_id = (select auth.uid()));
$$;

create or replace function private.is_workspace_admin(p_workspace_id uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.workspace_members wm
    where wm.workspace_id = p_workspace_id and wm.user_id = (select auth.uid())
      and wm.role in ('owner', 'admin'));
$$;

-- Read: any workspace member, or a company-scoped member.
create or replace function private.can_read_company(p_company_id uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.companies c
    join public.workspace_members wm on wm.workspace_id = c.workspace_id
    where c.id = p_company_id and wm.user_id = (select auth.uid()))
  or exists (
    select 1 from public.company_members cm
    where cm.company_id = p_company_id and cm.user_id = (select auth.uid()));
$$;

-- Manage (add data, connect sources, trigger syncs): workspace owner/admin/member
-- or company_admin. company_viewer is read-only.
create or replace function private.can_manage_company(p_company_id uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.companies c
    join public.workspace_members wm on wm.workspace_id = c.workspace_id
    where c.id = p_company_id and wm.user_id = (select auth.uid())
      and wm.role in ('owner', 'admin', 'member'))
  or exists (
    select 1 from public.company_members cm
    where cm.company_id = p_company_id and cm.user_id = (select auth.uid())
      and cm.role = 'company_admin');
$$;

-- Fixed-window rate limiter. Returns true if the hit is allowed.
create or replace function private.rate_limit_hit(p_bucket text, p_limit integer, p_window_seconds integer)
returns boolean
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_window timestamptz := to_timestamp(floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds);
  v_hits integer;
begin
  insert into private.rate_limit_counters as r (bucket, window_start, hits)
  values (p_bucket, v_window, 1)
  on conflict (bucket, window_start) do update set hits = r.hits + 1
  returning hits into v_hits;
  return v_hits <= p_limit;
end;
$$;

revoke all on all functions in schema private from public, anon;
grant execute on function private.workspace_role(uuid), private.is_workspace_member(uuid),
  private.is_workspace_admin(uuid), private.can_read_company(uuid), private.can_manage_company(uuid)
  to authenticated;
revoke execute on function private.rate_limit_hit(text, integer, integer) from authenticated;
grant execute on function private.rate_limit_hit(text, integer, integer) to service_role;

-- ---------------------------------------------------------------------------
-- Enable RLS everywhere
-- ---------------------------------------------------------------------------

alter table public.profiles enable row level security;
alter table public.workspaces enable row level security;
alter table public.workspace_members enable row level security;
alter table public.companies enable row level security;
alter table public.company_members enable row level security;
alter table public.company_settings enable row level security;
alter table public.cloud_projects enable row level security;
alter table public.analytics_resources enable row level security;
alter table public.connector_providers enable row level security;
alter table public.company_connections enable row level security;
alter table public.connection_secrets enable row level security;
alter table public.oauth_states enable row level security;
alter table public.sync_schedules enable row level security;
alter table public.csv_uploads enable row level security;
alter table public.sync_runs enable row level security;
alter table public.sync_checkpoints enable row level security;
alter table public.provisioning_jobs enable row level security;
alter table public.job_attempts enable row level security;
alter table public.data_quality_issues enable row level security;
alter table public.metric_definitions enable row level security;
alter table public.usage_events enable row level security;
alter table public.audit_logs enable row level security;

-- Belt and braces: anon gets nothing at all.
revoke all on all tables in schema public from anon;

-- Server-only tables: no privileges for API roles (RLS has no policies either).
revoke all on public.connection_secrets, public.oauth_states, public.cloud_projects from authenticated;

-- Authenticated users write only through RPCs, except a few safe column updates.
revoke insert, update, delete, truncate on all tables in schema public from authenticated;

-- profiles
create policy profiles_select_own on public.profiles for select to authenticated
  using (id = (select auth.uid()));
create policy profiles_update_own on public.profiles for update to authenticated
  using (id = (select auth.uid())) with check (id = (select auth.uid()));
grant update (display_name) on public.profiles to authenticated;

-- workspaces
create policy workspaces_select_member on public.workspaces for select to authenticated
  using (private.is_workspace_member(id));
create policy workspaces_update_admin on public.workspaces for update to authenticated
  using (private.is_workspace_admin(id)) with check (private.is_workspace_admin(id));
grant update (name) on public.workspaces to authenticated;

-- workspace_members: read-only for members; changes only through future RPCs
-- (prevents self role escalation).
create policy workspace_members_select on public.workspace_members for select to authenticated
  using (private.is_workspace_member(workspace_id));

-- companies
create policy companies_select on public.companies for select to authenticated
  using (private.can_read_company(id));
create policy companies_update on public.companies for update to authenticated
  using (private.can_manage_company(id)) with check (private.can_manage_company(id));
grant update (name, website, industry, country, timezone) on public.companies to authenticated;

create policy company_members_select on public.company_members for select to authenticated
  using (private.can_read_company(company_id));

create policy company_settings_select on public.company_settings for select to authenticated
  using (private.can_read_company(company_id));
create policy company_settings_update on public.company_settings for update to authenticated
  using (private.can_manage_company(company_id)) with check (private.can_manage_company(company_id));
grant update (sync_local_time, reporting_currency) on public.company_settings to authenticated;

create policy analytics_resources_select on public.analytics_resources for select to authenticated
  using (private.can_read_company(company_id));

create policy connector_providers_select on public.connector_providers for select to authenticated
  using (true);
create policy metric_definitions_select on public.metric_definitions for select to authenticated
  using (true);

create policy company_connections_select on public.company_connections for select to authenticated
  using (private.can_read_company(company_id));
create policy sync_schedules_select on public.sync_schedules for select to authenticated
  using (private.can_read_company(company_id));
create policy sync_runs_select on public.sync_runs for select to authenticated
  using (private.can_read_company(company_id));
create policy sync_checkpoints_select on public.sync_checkpoints for select to authenticated
  using (private.can_read_company(company_id));
create policy provisioning_jobs_select on public.provisioning_jobs for select to authenticated
  using (private.can_read_company(company_id));
create policy job_attempts_select on public.job_attempts for select to authenticated
  using (private.can_read_company(company_id));
create policy data_quality_select on public.data_quality_issues for select to authenticated
  using (private.can_read_company(company_id));

-- csv_uploads: metadata readable; the stored rows column is not granted.
create policy csv_uploads_select on public.csv_uploads for select to authenticated
  using (private.can_read_company(company_id));
revoke select on public.csv_uploads from authenticated;
grant select (id, workspace_id, company_id, uploaded_by, filename, byte_size, row_count,
  content_sha256, summary, status, created_at) on public.csv_uploads to authenticated;

-- usage & audit: workspace owner/admin only.
create policy usage_events_select on public.usage_events for select to authenticated
  using (private.is_workspace_admin(workspace_id));
create policy audit_logs_select on public.audit_logs for select to authenticated
  using (workspace_id is not null and private.is_workspace_admin(workspace_id));

-- ---------------------------------------------------------------------------
-- Profile row on sign-up (no workspace yet: workspace is created only after
-- the email is verified, by bootstrap_workspace()).
-- ---------------------------------------------------------------------------

create or replace function private.handle_new_user()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  insert into public.profiles (id) values (new.id) on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function private.handle_new_user();

-- ---------------------------------------------------------------------------
-- RPC: bootstrap_workspace — idempotent, requires a verified email.
-- ---------------------------------------------------------------------------

create or replace function public.bootstrap_workspace(p_name text default null)
returns uuid
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_confirmed timestamptz;
  v_email text;
  v_ws uuid;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;

  select u.email_confirmed_at, u.email into v_confirmed, v_email from auth.users u where u.id = v_uid;
  if v_confirmed is null then
    raise exception 'email not verified' using errcode = '28000';
  end if;

  -- Serialize concurrent bootstrap calls for the same user.
  perform pg_advisory_xact_lock(hashtextextended('bootstrap:' || v_uid::text, 0));

  select w.id into v_ws from public.workspaces w where w.created_by = v_uid;
  if v_ws is null then
    insert into public.workspaces (name, created_by)
    values (coalesce(nullif(btrim(p_name), ''), 'My workspace'), v_uid)
    returning id into v_ws;
    insert into public.workspace_members (workspace_id, user_id, role) values (v_ws, v_uid, 'owner');
    insert into public.profiles (id, default_workspace_id) values (v_uid, v_ws)
      on conflict (id) do update set default_workspace_id = coalesce(public.profiles.default_workspace_id, excluded.default_workspace_id);
    insert into public.audit_logs (workspace_id, actor_user_id, action, target_type, target_id)
    values (v_ws, v_uid, 'workspace.created', 'workspace', v_ws::text);
  end if;
  return v_ws;
end;
$$;

-- ---------------------------------------------------------------------------
-- RPC: create_company — company + settings + provisioning job, one transaction.
-- ---------------------------------------------------------------------------

create or replace function public.create_company(
  p_workspace_id uuid,
  p_name text,
  p_website text default null,
  p_industry text default null,
  p_country text default null,
  p_timezone text default 'UTC'
)
returns uuid
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_role text;
  v_count integer;
  v_max integer;
  v_company uuid;
  v_tz text := coalesce(nullif(btrim(p_timezone), ''), 'UTC');
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;

  v_role := private.workspace_role(p_workspace_id);
  if v_role is null or v_role not in ('owner', 'admin', 'member') then
    -- Same error for "does not exist" and "not yours": no tenant enumeration.
    raise exception 'workspace not found' using errcode = '42501';
  end if;

  if not exists (select 1 from pg_catalog.pg_timezone_names where name = v_tz) then
    raise exception 'invalid timezone' using errcode = '22023';
  end if;

  if not private.rate_limit_hit('create_company:' || v_uid::text, 20, 3600) then
    raise exception 'rate limit exceeded' using errcode = 'P0429';
  end if;

  -- Admission control: per-workspace company cap.
  select w.max_companies into v_max from public.workspaces w where w.id = p_workspace_id for update;
  select count(*) into v_count from public.companies c where c.workspace_id = p_workspace_id and c.status = 'active';
  if v_count >= v_max then
    raise exception 'company limit reached' using errcode = 'P0402';
  end if;

  insert into public.companies (workspace_id, name, website, industry, country, timezone, created_by)
  values (p_workspace_id, btrim(p_name), nullif(btrim(p_website), ''), nullif(btrim(p_industry), ''),
          nullif(upper(btrim(p_country)), ''), v_tz, v_uid)
  returning id into v_company;

  insert into public.company_settings (company_id, workspace_id) values (v_company, p_workspace_id);

  insert into public.provisioning_jobs (workspace_id, company_id, idempotency_key)
  values (p_workspace_id, v_company, 'create_dataset:' || v_company::text);

  insert into public.audit_logs (workspace_id, company_id, actor_user_id, action, target_type, target_id, metadata)
  values (p_workspace_id, v_company, v_uid, 'company.created', 'company', v_company::text,
          jsonb_build_object('name', btrim(p_name)));
  return v_company;
end;
$$;

-- ---------------------------------------------------------------------------
-- RPC: retry_provisioning — re-queue a failed/dead provisioning job.
-- ---------------------------------------------------------------------------

create or replace function public.retry_provisioning(p_company_id uuid)
returns uuid
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_ws uuid;
  v_job uuid;
begin
  if v_uid is null or not private.can_manage_company(p_company_id) then
    raise exception 'company not found' using errcode = '42501';
  end if;
  select c.workspace_id into v_ws from public.companies c where c.id = p_company_id;

  if exists (select 1 from public.analytics_resources r where r.company_id = p_company_id and r.status = 'ready') then
    raise exception 'already provisioned' using errcode = '22023';
  end if;
  select j.id into v_job from public.provisioning_jobs j
   where j.company_id = p_company_id and j.status in ('queued', 'running');
  if v_job is not null then
    return v_job;
  end if;

  insert into public.provisioning_jobs (workspace_id, company_id, idempotency_key)
  values (v_ws, p_company_id, 'create_dataset:' || p_company_id::text || ':retry:' || gen_random_uuid()::text)
  returning id into v_job;
  insert into public.audit_logs (workspace_id, company_id, actor_user_id, action, target_type, target_id)
  values (v_ws, p_company_id, v_uid, 'provisioning.retried', 'provisioning_job', v_job::text);
  return v_job;
end;
$$;

-- ---------------------------------------------------------------------------
-- RPC: ensure_csv_connection — the manual CSV "connection" for a company.
-- ---------------------------------------------------------------------------

create or replace function public.ensure_csv_connection(p_company_id uuid)
returns uuid
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_ws uuid;
  v_conn uuid;
begin
  if v_uid is null or not private.can_manage_company(p_company_id) then
    raise exception 'company not found' using errcode = '42501';
  end if;
  select c.workspace_id into v_ws from public.companies c where c.id = p_company_id;
  select cc.id into v_conn from public.company_connections cc
   where cc.company_id = p_company_id and cc.provider_id = 'csv' and cc.mode = 'manual';
  if v_conn is null then
    insert into public.company_connections (workspace_id, company_id, provider_id, mode, status, created_by)
    values (v_ws, p_company_id, 'csv', 'manual', 'connected', v_uid)
    on conflict do nothing
    returning id into v_conn;
    if v_conn is null then
      select cc.id into v_conn from public.company_connections cc
       where cc.company_id = p_company_id and cc.provider_id = 'csv' and cc.mode = 'manual';
    end if;
  end if;
  return v_conn;
end;
$$;

-- ---------------------------------------------------------------------------
-- RPC: enable_simulated_connection — sample-data connector, clearly flagged.
-- ---------------------------------------------------------------------------

create or replace function public.enable_simulated_connection(p_company_id uuid, p_provider_id text)
returns uuid
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_ws uuid;
  v_tz text;
  v_conn uuid;
  v_local time;
  v_buffer integer;
begin
  if v_uid is null or not private.can_manage_company(p_company_id) then
    raise exception 'company not found' using errcode = '42501';
  end if;
  if not exists (select 1 from public.connector_providers p where p.id = p_provider_id and p.supports_simulation) then
    raise exception 'provider does not support simulation' using errcode = '22023';
  end if;
  select c.workspace_id, c.timezone into v_ws, v_tz from public.companies c where c.id = p_company_id;
  select s.sync_local_time into v_local from public.company_settings s where s.company_id = p_company_id;

  select cc.id into v_conn from public.company_connections cc
   where cc.company_id = p_company_id and cc.provider_id = p_provider_id and cc.mode = 'simulated';
  if v_conn is null then
    insert into public.company_connections (workspace_id, company_id, provider_id, mode, status,
      external_account_id, external_account_name, created_by)
    values (v_ws, p_company_id, p_provider_id, 'simulated', 'connected',
      'sample-' || p_provider_id, 'Sample data (simulated)', v_uid)
    returning id into v_conn;

    v_buffer := case p_provider_id when 'ga4' then 60 else 30 end;
    insert into public.sync_schedules (workspace_id, company_id, connection_id, frequency, local_time, timezone, buffer_minutes, next_run_at)
    values (v_ws, p_company_id, v_conn, 'daily', coalesce(v_local, '06:00'), v_tz, v_buffer, now());

    insert into public.audit_logs (workspace_id, company_id, actor_user_id, action, target_type, target_id, metadata)
    values (v_ws, p_company_id, v_uid, 'connection.simulated_enabled', 'connection', v_conn::text,
            jsonb_build_object('provider', p_provider_id));
  end if;
  return v_conn;
end;
$$;

-- ---------------------------------------------------------------------------
-- RPC: request_sync — manual sync / backfill request (rate limited, idempotent per window).
-- ---------------------------------------------------------------------------

create or replace function public.request_sync(
  p_connection_id uuid,
  p_window_start date default null,
  p_window_end date default null
)
returns uuid
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_conn record;
  v_run uuid;
  v_key text;
begin
  select cc.* into v_conn from public.company_connections cc where cc.id = p_connection_id;
  if v_uid is null or v_conn.id is null or not private.can_manage_company(v_conn.company_id) then
    raise exception 'connection not found' using errcode = '42501';
  end if;
  if v_conn.provider_id = 'csv' then
    raise exception 'csv connections sync on upload' using errcode = '22023';
  end if;
  if v_conn.status = 'disconnected' then
    raise exception 'connection is disconnected' using errcode = '22023';
  end if;
  if (p_window_start is null) <> (p_window_end is null) then
    raise exception 'window must have both start and end' using errcode = '22023';
  end if;
  if p_window_start is not null and (p_window_end < p_window_start or p_window_end - p_window_start > 400) then
    raise exception 'invalid window' using errcode = '22023';
  end if;
  if not private.rate_limit_hit('request_sync:' || v_uid::text, 30, 3600) then
    raise exception 'rate limit exceeded' using errcode = 'P0429';
  end if;

  select r.id into v_run from public.sync_runs r
   where r.connection_id = p_connection_id and r.status in ('queued', 'running');
  if v_run is not null then
    return v_run;
  end if;

  v_key := 'manual:' || p_connection_id::text || ':' || gen_random_uuid()::text;
  insert into public.sync_runs (workspace_id, company_id, connection_id, provider_id, trigger,
    window_start, window_end, idempotency_key, is_simulated, created_by)
  values (v_conn.workspace_id, v_conn.company_id, p_connection_id, v_conn.provider_id,
    case when p_window_start is null then 'manual' else 'backfill' end,
    p_window_start, p_window_end, v_key, v_conn.mode = 'simulated', v_uid)
  returning id into v_run;

  insert into public.audit_logs (workspace_id, company_id, actor_user_id, action, target_type, target_id)
  values (v_conn.workspace_id, v_conn.company_id, v_uid, 'sync.requested', 'sync_run', v_run::text);
  return v_run;
end;
$$;

-- ---------------------------------------------------------------------------
-- RPC: queue_csv_import — turn a validated upload into a sync run (idempotent).
-- ---------------------------------------------------------------------------

create or replace function public.queue_csv_import(p_upload_id uuid)
returns uuid
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_up record;
  v_conn uuid;
  v_run uuid;
begin
  select u.id, u.workspace_id, u.company_id, u.status into v_up from public.csv_uploads u where u.id = p_upload_id;
  if v_uid is null or v_up.id is null or not private.can_manage_company(v_up.company_id) then
    raise exception 'upload not found' using errcode = '42501';
  end if;

  select r.id into v_run from public.sync_runs r where r.idempotency_key = 'csv:' || p_upload_id::text;
  if v_run is not null then
    return v_run;
  end if;

  v_conn := public.ensure_csv_connection(v_up.company_id);
  insert into public.sync_runs (workspace_id, company_id, connection_id, provider_id, trigger,
    csv_upload_id, idempotency_key, created_by)
  values (v_up.workspace_id, v_up.company_id, v_conn, 'csv', 'csv_upload', p_upload_id,
    'csv:' || p_upload_id::text, v_uid)
  returning id into v_run;
  update public.csv_uploads set status = 'queued' where id = p_upload_id;
  insert into public.audit_logs (workspace_id, company_id, actor_user_id, action, target_type, target_id)
  values (v_up.workspace_id, v_up.company_id, v_uid, 'csv.import_queued', 'csv_upload', p_upload_id::text);
  return v_run;
end;
$$;

-- ---------------------------------------------------------------------------
-- RPC: disconnect_connection — stops syncing; keeps all warehouse data
-- (deletion requires a separately designed retention/deletion process).
-- ---------------------------------------------------------------------------

create or replace function public.disconnect_connection(p_connection_id uuid)
returns void
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_conn record;
begin
  select cc.id, cc.workspace_id, cc.company_id into v_conn from public.company_connections cc where cc.id = p_connection_id;
  if v_uid is null or v_conn.id is null or not private.can_manage_company(v_conn.company_id) then
    raise exception 'connection not found' using errcode = '42501';
  end if;
  update public.company_connections set status = 'disconnected', updated_at = now() where id = p_connection_id;
  update public.sync_schedules set enabled = false, updated_at = now() where connection_id = p_connection_id;
  delete from public.connection_secrets where connection_id = p_connection_id;
  update public.sync_runs set status = 'cancelled', finished_at = now()
   where connection_id = p_connection_id and status = 'queued';
  insert into public.audit_logs (workspace_id, company_id, actor_user_id, action, target_type, target_id)
  values (v_conn.workspace_id, v_conn.company_id, v_uid, 'connection.disconnected', 'connection', p_connection_id::text);
end;
$$;

-- RPC grants: authenticated only.
revoke all on function public.bootstrap_workspace(text) from public, anon;
revoke all on function public.create_company(uuid, text, text, text, text, text) from public, anon;
revoke all on function public.retry_provisioning(uuid) from public, anon;
revoke all on function public.ensure_csv_connection(uuid) from public, anon;
revoke all on function public.enable_simulated_connection(uuid, text) from public, anon;
revoke all on function public.request_sync(uuid, date, date) from public, anon;
revoke all on function public.queue_csv_import(uuid) from public, anon;
revoke all on function public.disconnect_connection(uuid) from public, anon;
grant execute on function public.bootstrap_workspace(text), public.create_company(uuid, text, text, text, text, text),
  public.retry_provisioning(uuid), public.ensure_csv_connection(uuid), public.enable_simulated_connection(uuid, text),
  public.request_sync(uuid, date, date), public.queue_csv_import(uuid), public.disconnect_connection(uuid)
  to authenticated;
revoke execute on function private.handle_new_user() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Reference data
-- ---------------------------------------------------------------------------

insert into public.connector_providers (id, display_name, category, availability, supports_oauth, supports_simulation, default_lookback_days, finalization_days, description) values
  ('csv', 'CSV import', 'file', 'available', false, false, 0, 0, 'Upload daily campaign/source metrics using the documented CSV template.'),
  ('ga4', 'Google Analytics 4', 'analytics', 'requires_admin_setup', true, true, 3, 3, 'Daily report metrics (sessions, key events, revenue) through the Google Analytics Data API. Requires an administrator-configured Google OAuth client.'),
  ('google_ads', 'Google Ads', 'advertising', 'requires_admin_setup', true, true, 14, 14, 'Daily campaign metrics (cost, impressions, clicks, conversions) through the Google Ads API. Requires an administrator-configured Google Cloud project with Google Ads API access.'),
  ('meta_ads', 'Meta Ads', 'advertising', 'planned', true, false, 7, 7, 'Planned. Not available in Phase 1. Use CSV import meanwhile.'),
  ('microsoft_ads', 'Microsoft Advertising', 'advertising', 'planned', true, false, 7, 7, 'Planned. Not available in Phase 1. Use CSV import meanwhile.'),
  ('microsoft_clarity', 'Microsoft Clarity', 'behavior', 'planned', false, false, 3, 3, 'Planned. Not available in Phase 1.'),
  ('semrush', 'Semrush', 'seo', 'planned', false, false, 7, 7, 'Planned. Requires a paid Semrush API plan; availability not verified.'),
  ('tiktok_ads', 'TikTok Ads', 'advertising', 'planned', true, false, 7, 7, 'Planned. Not available in Phase 1. Use CSV import meanwhile.'),
  ('shopify', 'Shopify', 'commerce', 'planned', true, false, 3, 3, 'Planned. Not available in Phase 1.'),
  ('wordpress', 'WordPress', 'cms', 'planned', false, false, 3, 3, 'Planned. Not available in Phase 1.'),
  ('crm', 'CRM platforms', 'crm', 'planned', true, false, 3, 3, 'Planned. Not available in Phase 1. Use CSV import (leads column) meanwhile.'),
  ('yelp_ads', 'Yelp Ads', 'reviews', 'requires_partner_access', false, false, 7, 7, 'Requires Yelp partner access and separate API entitlements. Not available; no scraping.'),
  ('call_tracking', 'Call tracking / telephony', 'telephony', 'planned', false, false, 3, 3, 'Planned. Not available in Phase 1.');

insert into public.metric_definitions (key, name, formula, unit, requires, description) values
  ('cpc', 'Cost per click', 'spend / clicks', 'currency', '{spend,clicks}', 'Ad spend divided by ad clicks. Same currency and same ad platform only.'),
  ('ctr', 'Click-through rate', 'clicks / impressions * 100', 'percent', '{clicks,impressions}', 'Ad clicks divided by ad impressions.'),
  ('cpm', 'Cost per 1,000 impressions', 'spend / impressions * 1000', 'currency', '{spend,impressions}', 'Ad spend per thousand impressions.'),
  ('cpl', 'Cost per lead', 'spend / leads', 'currency', '{spend,leads}', 'Only when the source supplies dependable lead counts (CSV leads column).'),
  ('conversion_rate', 'Conversion rate', 'conversions / clicks * 100', 'percent', '{conversions,clicks}', 'Platform-reported conversions divided by clicks of the same platform. Denominator is clicks.'),
  ('roas', 'Return on ad spend (platform-reported)', 'attributed_revenue / spend', 'ratio', '{attributed_revenue,spend}', 'Attributed revenue reported by the same source divided by its spend. Not verified billed revenue.'),
  ('cac', 'Customer acquisition cost', 'not computed in Phase 1', 'currency', '{spend,new_customers}', 'Not available: Phase 1 has no customer data source.'),
  ('roi', 'Return on investment', 'not computed in Phase 1', 'percent', '{profit,spend}', 'Not available: Phase 1 has no profit/cost-of-goods data.');
