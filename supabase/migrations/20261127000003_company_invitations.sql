-- Users with access to chosen companies only: invitations by email.
-- The owner/admin of a workspace invites an email address as Viewer (company_viewer,
-- read only) or Editor (company_admin: connect sources, upload, change settings)
-- for the companies they tick. The invited person signs up or logs in with that
-- email; once the email is verified, the invitation is accepted automatically.
-- Written only by the server (owner/admin checked there); no direct client access.

create table public.company_invitations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  email text not null check (email = lower(btrim(email)) and char_length(email) between 3 and 254 and email ~ '^[^\s@]+@[^\s@]+\.[^\s@]+$'),
  role text not null check (role in ('company_admin', 'company_viewer')),
  company_ids uuid[] not null check (cardinality(company_ids) between 1 and 500),
  invited_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '30 days',
  accepted_at timestamptz,
  accepted_by uuid references auth.users (id) on delete set null,
  revoked_at timestamptz
);
create index company_invitations_open_idx on public.company_invitations (email)
  where accepted_at is null and revoked_at is null;
create index company_invitations_workspace_idx on public.company_invitations (workspace_id);
alter table public.company_invitations enable row level security;
-- No policies: only the server (owner/admin checked) and accept_my_invitations() touch it.

-- Called on every app visit: accepts open invitations for the signed-in user's
-- VERIFIED email. Never trusts caller input. Returns how many were accepted.
create or replace function public.accept_my_invitations()
returns integer
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_email text;
  v_confirmed timestamptz;
  v_inv record;
  v_n integer := 0;
begin
  if v_uid is null then return 0; end if;
  select lower(u.email), u.email_confirmed_at into v_email, v_confirmed from auth.users u where u.id = v_uid;
  if v_email is null or v_confirmed is null then return 0; end if;
  for v_inv in
    select i.* from public.company_invitations i
     where i.email = v_email and i.accepted_at is null and i.revoked_at is null and i.expires_at > now()
     for update
  loop
    insert into public.company_members (company_id, workspace_id, user_id, role)
    select c.id, c.workspace_id, v_uid, v_inv.role
      from public.companies c
     where c.id = any (v_inv.company_ids) and c.workspace_id = v_inv.workspace_id and c.status = 'active'
    on conflict (company_id, user_id) do update set role = excluded.role;
    update public.company_invitations set accepted_at = now(), accepted_by = v_uid where id = v_inv.id;
    insert into public.audit_logs (workspace_id, actor_user_id, action, target_type, target_id)
    values (v_inv.workspace_id, v_uid, 'invitation.accepted', 'invitation', v_inv.id::text);
    v_n := v_n + 1;
  end loop;
  return v_n;
end;
$$;
revoke execute on function public.accept_my_invitations() from public, anon;
grant execute on function public.accept_my_invitations() to authenticated;
