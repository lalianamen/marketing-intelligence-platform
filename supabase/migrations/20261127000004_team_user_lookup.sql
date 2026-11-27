-- The app's server role (mip_app in production) may not read the auth schema.
-- The Users page needs two narrow lookups, given here as SECURITY DEFINER
-- functions owned by the migration role: emails of given user ids, and the id
-- of the account with a given email. Not callable by API users.

create or replace function private.user_emails(p_ids uuid[])
returns table (id uuid, email text)
language sql stable security definer set search_path = ''
as $$
  select u.id, lower(u.email) from auth.users u where u.id = any (p_ids);
$$;

create or replace function private.user_id_by_email(p_email text, p_verified_only boolean default false)
returns uuid
language sql stable security definer set search_path = ''
as $$
  select u.id from auth.users u
   where lower(u.email) = lower(btrim(p_email)) and (not p_verified_only or u.email_confirmed_at is not null)
   limit 1;
$$;

revoke execute on function private.user_emails(uuid[]) from public, anon, authenticated;
revoke execute on function private.user_id_by_email(text, boolean) from public, anon, authenticated;
grant execute on function private.user_emails(uuid[]) to service_role;
grant execute on function private.user_id_by_email(text, boolean) to service_role;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'mip_app') then
    grant execute on function private.user_emails(uuid[]) to mip_app;
    grant execute on function private.user_id_by_email(text, boolean) to mip_app;
  end if;
end;
$$;
