-- Company deletion.
--
-- Two phases, so the warehouse dataset is never orphaned:
--   1. delete_company RPC (user): checks the typed name, marks the company
--      'deleting', stops all work (cancels queued runs, disables schedules,
--      removes stored tokens) and queues a 'delete_dataset' job.
--   2. Worker: verifies the dataset labels belong to this company, drops the
--      dataset, removes the registry row and finally deletes the company row
--      (cascades to connections, uploads, runs, settings).
-- audit_logs and usage_events keep company_id without a foreign key, so the
-- history of the deletion stays.

alter table public.companies drop constraint companies_status_check;
alter table public.companies add constraint companies_status_check
  check (status in ('active', 'archived', 'deleting'));
alter table public.companies add column deletion_requested_at timestamptz;

alter table public.provisioning_jobs drop constraint provisioning_jobs_kind_check;
alter table public.provisioning_jobs add constraint provisioning_jobs_kind_check
  check (kind in ('create_dataset', 'delete_dataset'));

-- A company that is being deleted can no longer be managed (no new syncs,
-- uploads, connections or edits), whatever path the request takes.
create or replace function private.can_manage_company(p_company_id uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.companies c
    join public.workspace_members wm on wm.workspace_id = c.workspace_id
    where c.id = p_company_id and c.status = 'active' and wm.user_id = (select auth.uid())
      and wm.role in ('owner', 'admin', 'member'))
  or exists (
    select 1 from public.company_members cm
    join public.companies c on c.id = cm.company_id
    where cm.company_id = p_company_id and c.status = 'active' and cm.user_id = (select auth.uid())
      and cm.role = 'company_admin');
$$;

create or replace function public.delete_company(p_company_id uuid, p_confirm_name text)
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
  -- Only workspace owners/admins may delete. Same error as "missing" so ids cannot be probed.
  if v_company.id is null or not private.is_workspace_admin(v_company.workspace_id) then
    raise exception 'company not found' using errcode = '42501';
  end if;

  if v_company.status = 'deleting' then
    select j.id into v_job from public.provisioning_jobs j
     where j.company_id = p_company_id and j.kind = 'delete_dataset' and j.status in ('queued', 'running');
    if v_job is not null then
      return v_job;
    end if;
  elsif lower(btrim(coalesce(p_confirm_name, ''))) <> lower(btrim(v_company.name)) then
    raise exception 'confirmation name does not match' using errcode = '22023';
  end if;

  if not private.rate_limit_hit('delete_company:' || v_uid::text, 20, 3600) then
    raise exception 'rate limit exceeded' using errcode = 'P0429';
  end if;

  -- A dataset creation in progress must finish (or fail) first; otherwise it
  -- could create the dataset after we dropped it.
  if exists (select 1 from public.provisioning_jobs j
              where j.company_id = p_company_id and j.kind = 'create_dataset' and j.status = 'running') then
    raise exception 'company busy, try again in a minute' using errcode = '55006';
  end if;

  update public.companies
     set status = 'deleting', deletion_requested_at = coalesce(deletion_requested_at, now()), updated_at = now()
   where id = p_company_id;

  -- Stop all work for the company.
  update public.provisioning_jobs
     set status = 'dead', last_error_code = 'company_deleted', last_error = 'company deletion requested',
         finished_at = now(), updated_at = now()
   where company_id = p_company_id and kind = 'create_dataset' and status in ('queued', 'failed');
  update public.sync_runs set status = 'cancelled', finished_at = now()
   where company_id = p_company_id and status = 'queued';
  update public.sync_schedules set enabled = false, updated_at = now() where company_id = p_company_id;
  delete from public.connection_secrets s
   using public.company_connections cc
   where cc.id = s.connection_id and cc.company_id = p_company_id;
  update public.company_connections set status = 'disconnected', updated_at = now()
   where company_id = p_company_id and status <> 'disconnected';

  insert into public.provisioning_jobs (workspace_id, company_id, kind, idempotency_key)
  values (v_company.workspace_id, p_company_id, 'delete_dataset', 'delete_dataset:' || p_company_id::text)
  on conflict (idempotency_key) do update set status = 'queued', attempts = 0, run_after = now(),
     last_error_code = null, last_error = null, finished_at = null, updated_at = now()
  returning id into v_job;

  insert into public.audit_logs (workspace_id, company_id, actor_user_id, action, target_type, target_id, metadata)
  values (v_company.workspace_id, p_company_id, v_uid, 'company.deletion_requested', 'company', p_company_id::text,
          jsonb_build_object('name', v_company.name));
  return v_job;
end;
$$;

revoke all on function public.delete_company(uuid, text) from public, anon;
grant execute on function public.delete_company(uuid, text) to authenticated;
