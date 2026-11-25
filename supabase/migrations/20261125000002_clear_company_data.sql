-- "Clear all data" for a company: start over without deleting the company.
--   1. clear_company_data RPC (owner/admin, typed company name): removes
--      connections (with stored tokens, schedules, runs, checkpoints), CSV
--      uploads, data checks and pending sign-ins, and queues a 'clear_data' job.
--   2. Worker: verifies the dataset labels and empties the warehouse tables
--      (raw, normalized, mart). The dataset and its schema stay.

alter table public.provisioning_jobs drop constraint provisioning_jobs_kind_check;
alter table public.provisioning_jobs add constraint provisioning_jobs_kind_check
  check (kind in ('create_dataset', 'delete_dataset', 'clear_data'));

create or replace function public.clear_company_data(p_company_id uuid, p_confirm_name text)
returns uuid
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_company record;
  v_job uuid;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  select c.id, c.workspace_id, c.name, c.status into v_company
    from public.companies c where c.id = p_company_id for update;
  if v_company.id is null or v_company.status <> 'active' or not private.is_workspace_admin(v_company.workspace_id) then
    raise exception 'company not found' using errcode = '42501';
  end if;
  if lower(btrim(coalesce(p_confirm_name, ''))) <> lower(btrim(v_company.name)) then
    raise exception 'confirmation name does not match' using errcode = '22023';
  end if;
  if not private.rate_limit_hit('clear_company_data:' || v_uid::text, 20, 3600) then
    raise exception 'rate limit exceeded' using errcode = 'P0429';
  end if;
  if not exists (select 1 from public.analytics_resources r where r.company_id = p_company_id and r.status = 'ready') then
    raise exception 'company busy, try again in a minute' using errcode = '55006';
  end if;
  if exists (select 1 from public.provisioning_jobs j where j.company_id = p_company_id and j.status in ('queued', 'running'))
     or exists (select 1 from public.sync_runs s where s.company_id = p_company_id and s.status = 'running') then
    raise exception 'company busy, try again in a minute' using errcode = '55006';
  end if;

  delete from public.data_quality_issues where company_id = p_company_id;
  delete from public.oauth_pending_grants where company_id = p_company_id;
  delete from public.oauth_states where company_id = p_company_id;
  delete from public.sync_runs where company_id = p_company_id;
  -- Cascades to connection_secrets, sync_schedules, sync_checkpoints.
  delete from public.company_connections where company_id = p_company_id;
  delete from public.csv_uploads where company_id = p_company_id;

  insert into public.provisioning_jobs (workspace_id, company_id, kind, idempotency_key)
  values (v_company.workspace_id, p_company_id, 'clear_data', 'clear_data:' || p_company_id::text || ':' || gen_random_uuid()::text)
  returning id into v_job;

  insert into public.audit_logs (workspace_id, company_id, actor_user_id, action, target_type, target_id, metadata)
  values (v_company.workspace_id, p_company_id, v_uid, 'company.data_clear_requested', 'company', p_company_id::text,
          jsonb_build_object('name', v_company.name));
  return v_job;
end;
$$;

revoke all on function public.clear_company_data(uuid, text) from public, anon;
grant execute on function public.clear_company_data(uuid, text) to authenticated;
