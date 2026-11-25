-- Connector setup before the first load: a newly connected live source loads
-- nothing until the user has chosen the data (reports), the period and the
-- schedule and pressed "Start loading". activated_at is null while in setup.
-- Existing connections count as activated.

alter table public.company_connections add column activated_at timestamptz default now();
update public.company_connections set activated_at = coalesce(activated_at, created_at);
