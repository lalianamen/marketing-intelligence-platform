-- Internal hourly scheduler: the database wakes the app, so nothing has to be
-- configured outside the platform (Vercel Hobby cron runs only once a day).
--
-- private.configure_scheduler(app_url) is run once per environment by the
-- platform operator. It enables pg_cron + pg_net, creates a random token inside
-- Supabase Vault (nobody ever sees it), stores only its SHA-256 for the app to
-- check, and schedules an hourly GET <app_url>/api/jobs/run with that token.

create table if not exists private.scheduler_tokens (
  id integer primary key default 1 check (id = 1),
  token_sha256 text not null check (token_sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now()
);
revoke all on private.scheduler_tokens from public, anon, authenticated;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'mip_app') then
    grant usage on schema private to mip_app;
    grant select on private.scheduler_tokens to mip_app;
  end if;
end $$;

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

  perform cron.schedule(
    'mip-scheduler',
    '7 * * * *',
    format(
      $job$select net.http_get(
         url := %L,
         headers := jsonb_build_object('Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'mip_scheduler_token')),
         timeout_milliseconds := 60000)$job$,
      v_url || '/api/jobs/run'
    )
  );
  return 'scheduled hourly at minute 7: ' || v_url || '/api/jobs/run';
end;
$$;
revoke all on function private.configure_scheduler(text) from public, anon, authenticated;
