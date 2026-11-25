-- Loads are limited to one month per sync run so a large import cannot outgrow the
-- function time limit or a provider quota in one go and fail as a whole.
--  * request_sync: a manual window may cover at most 31 days.
--  * request_history: a longer period (up to 400 days back) is split into parts of up
--    to 31 days, one queued run each, newest first; every part is saved on its own, so
--    a failure retries only that part.

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
  if p_window_start is not null and (p_window_end < p_window_start or p_window_end - p_window_start > 30) then
    -- One sync covers at most 31 days; longer history goes through request_history (split into parts).
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

create or replace function public.request_history(p_connection_id uuid, p_from date, p_to date)
returns integer
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_conn record;
  v_end date;
  v_start date;
  v_parts integer := 0;
  v_today date;
begin
  select cc.*, co.timezone into v_conn
    from public.company_connections cc join public.companies co on co.id = cc.company_id
   where cc.id = p_connection_id;
  if v_uid is null or v_conn.id is null or not private.can_manage_company(v_conn.company_id) then
    raise exception 'connection not found' using errcode = '42501';
  end if;
  if v_conn.provider_id = 'csv' or v_conn.status = 'disconnected' then
    raise exception 'history can be loaded only for connected sources' using errcode = '22023';
  end if;
  v_today := (now() at time zone v_conn.timezone)::date;
  if p_from is null or p_to is null or p_to < p_from or p_to >= v_today or p_from < v_today - 400 then
    raise exception 'invalid window' using errcode = '22023';
  end if;
  if not private.rate_limit_hit('request_history:' || v_uid::text, 10, 3600) then
    raise exception 'rate limit exceeded' using errcode = 'P0429';
  end if;
  if exists (select 1 from public.sync_runs r where r.connection_id = p_connection_id and r.trigger = 'backfill' and r.status = 'queued') then
    raise exception 'history load already in progress' using errcode = '55006';
  end if;

  v_end := p_to;
  while v_end >= p_from loop
    v_start := greatest(p_from, v_end - 30);
    insert into public.sync_runs (workspace_id, company_id, connection_id, provider_id, trigger,
      window_start, window_end, idempotency_key, is_simulated, created_by, run_after)
    values (v_conn.workspace_id, v_conn.company_id, p_connection_id, v_conn.provider_id, 'backfill',
      v_start, v_end, 'history:' || p_connection_id::text || ':' || v_start || ':' || v_end || ':' || gen_random_uuid()::text,
      -- All parts runnable at once; the newest gets the earliest run_after, so it is claimed first.
      v_conn.mode = 'simulated', v_uid, now() - make_interval(secs => 1000 - v_parts));
    v_parts := v_parts + 1;
    v_end := v_start - 1;
  end loop;

  insert into public.audit_logs (workspace_id, company_id, actor_user_id, action, target_type, target_id, metadata)
  values (v_conn.workspace_id, v_conn.company_id, v_uid, 'sync.history_requested', 'connection', p_connection_id::text,
          jsonb_build_object('from', p_from, 'to', p_to, 'parts', v_parts));
  return v_parts;
end;
$$;

revoke all on function public.request_history(uuid, date, date) from public, anon;
grant execute on function public.request_history(uuid, date, date) to authenticated;
