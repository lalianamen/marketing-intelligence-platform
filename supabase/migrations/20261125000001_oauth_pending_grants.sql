-- After Google consent the app lists the user's GA4 properties / Google Ads
-- accounts. When there is more than one, the encrypted grant waits here
-- (max 30 minutes) until the user picks which ones to connect.
-- RLS on with NO policies: only the server (service role / pooled app role) reads it.

create table public.oauth_pending_grants (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  workspace_id uuid not null,
  company_id uuid not null,
  provider_id text not null references public.connector_providers (id),
  ciphertext text not null,
  scopes text[] not null default '{}',
  -- [{id, name, group}] as returned by Google; names only, no secrets.
  accounts jsonb not null default '[]',
  expires_at timestamptz not null default now() + interval '30 minutes',
  created_at timestamptz not null default now(),
  foreign key (company_id, workspace_id) references public.companies (id, workspace_id) on delete cascade
);
create index oauth_pending_grants_user_idx on public.oauth_pending_grants (user_id, expires_at);
alter table public.oauth_pending_grants enable row level security;
revoke all on public.oauth_pending_grants from anon, authenticated;
