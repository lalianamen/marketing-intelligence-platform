-- Job router.
--  * Priority: what a person is waiting for first (Update now, CSV import = 10), then
--    scheduled updates (50), then history loads (90). Claim order: priority, then run_after.
--  * Fairness: the worker claim (src/server/jobs/queue.ts) lets one company run at most
--    2 imports at a time, so one big history load cannot hold up everyone else.
--  * Wake-up: every minute the database counts waiting work and wakes as many app
--    workers as needed (about one per 10 waiting jobs, at most 5, minus those already
--    busy). With no work it calls nothing.

alter table public.sync_runs add column priority smallint not null default 50 check (priority between 0 and 100);

create or replace function private.sync_run_priority()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.priority := case
    when new.trigger in ('manual', 'csv_upload') then 10
    when new.trigger = 'backfill' and new.idempotency_key like 'history:%' then 90
    when new.trigger = 'backfill' then 40
    else 50
  end;
  return new;
end;
$$;

create trigger sync_runs_priority before insert on public.sync_runs
  for each row execute function private.sync_run_priority();

update public.sync_runs set priority = case
    when trigger in ('manual', 'csv_upload') then 10
    when trigger = 'backfill' and idempotency_key like 'history:%' then 90
    when trigger = 'backfill' then 40
    else 50 end
  where status = 'queued';

create index sync_runs_router_idx on public.sync_runs (priority, run_after) where status = 'queued';

create table if not exists private.scheduler_config (
  id integer primary key default 1 check (id = 1),
  app_url text not null check (app_url ~ '^https://[a-z0-9.-]+$'),
  updated_at timestamptz not null default now()
);
revoke all on private.scheduler_config from public, anon, authenticated;

-- Called every minute by pg_cron. Returns how many workers it woke.
create or replace function private.wake_workers()
returns integer
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_url text;
  v_work integer;
  v_busy integer;
  v_wake integer;
begin
  select app_url into v_url from private.scheduler_config where id = 1;
  if v_url is null then
    return 0;
  end if;
  select
    (select count(*) from public.sync_schedules s where s.enabled and s.frequency = 'daily' and s.next_run_at <= now())
    + (select count(*) from public.sync_runs r where r.status = 'queued' and r.run_after <= now())
    + (select count(*) from public.provisioning_jobs j where j.status = 'queued' and j.run_after <= now())
    + (select count(*) from public.sync_runs r where r.status = 'running' and r.locked_until < now())
    into v_work;
  if v_work = 0 then
    return 0;
  end if;
  select (select count(*) from public.sync_runs where status = 'running')
       + (select count(*) from public.provisioning_jobs where status = 'running')
    into v_busy;
  v_wake := least(5, ceil(v_work / 10.0)::integer) - v_busy;
  if v_wake < 1 and v_busy = 0 then
    v_wake := 1;
  end if;
  for i in 1 .. greatest(v_wake, 0) loop
    perform net.http_get(
      url := v_url || '/api/jobs/run',
      headers := jsonb_build_object('Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'mip_scheduler_token')),
      timeout_milliseconds := 60000
    );
  end loop;
  return greatest(v_wake, 0);
end;
$$;
revoke all on function private.wake_workers() from public, anon, authenticated;

create or replace function private.configure_scheduler(p_app_url text)
returns text
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_url text := rtrim(btrim(p_app_url), '/');
  v_token text;
begin
  if v_url !~ '^https://[a-z0-9.-]+$' then
    raise exception 'app url must be https://host' using errcode = '22023';
  end if;
  create extension if not exists pg_cron with schema pg_catalog;
  create extension if not exists pg_net with schema extensions;

  select decrypted_secret into v_token from vault.decrypted_secrets where name = 'mip_scheduler_token';
  if v_token is null then
    v_token := encode(extensions.gen_random_bytes(32), 'hex');
    perform vault.create_secret(v_token, 'mip_scheduler_token', 'Token the database uses to wake the app scheduler');
  end if;
  insert into private.scheduler_tokens (id, token_sha256)
  values (1, encode(extensions.digest(v_token, 'sha256'), 'hex'))
  on conflict (id) do update set token_sha256 = excluded.token_sha256, created_at = now();
  insert into private.scheduler_config (id, app_url) values (1, v_url)
  on conflict (id) do update set app_url = excluded.app_url, updated_at = now();

  begin
    perform cron.unschedule('mip-scheduler');
  exception when others then
    null;
  end;
  perform cron.schedule('mip-wake', '* * * * *', 'select private.wake_workers()');
  return 'router scheduled every minute: ' || v_url || '/api/jobs/run';
end;
$$;
revoke all on function private.configure_scheduler(text) from public, anon, authenticated;
