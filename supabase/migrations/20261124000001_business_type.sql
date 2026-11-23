-- Business type per company: drives recommended sources, headline KPIs and
-- wording. The warehouse data model stays the same for every type.

alter table public.companies
  add column business_type text not null default 'other'
  check (business_type in ('local_service', 'ecommerce', 'digital_products', 'retail_store', 'b2b_leads', 'other'));

grant update (business_type) on public.companies to authenticated;

-- Which business types a provider is most relevant for (empty = all).
alter table public.connector_providers
  add column relevant_for text[] not null default '{}';

update public.connector_providers set relevant_for = '{local_service,retail_store,b2b_leads}' where id = 'yelp_ads';
update public.connector_providers set relevant_for = '{local_service,b2b_leads}' where id = 'call_tracking';
update public.connector_providers set relevant_for = '{ecommerce}' where id = 'shopify';
update public.connector_providers set relevant_for = '{b2b_leads,local_service}' where id = 'crm';

insert into public.connector_providers (id, display_name, category, availability, supports_oauth, supports_simulation, default_lookback_days, finalization_days, description, relevant_for) values
  ('google_business_profile', 'Google Business Profile', 'reviews', 'planned', true, false, 7, 7, 'Planned. Calls, direction requests and website clicks from your Google listing.', '{local_service,retail_store}'),
  ('google_local_services_ads', 'Google Local Services Ads', 'advertising', 'planned', true, false, 14, 14, 'Planned. Leads and spend from Local Services Ads. API access not verified yet.', '{local_service}'),
  ('field_service_crm', 'Field service CRM (ServiceTitan, Jobber, Housecall Pro)', 'crm', 'planned', true, false, 3, 3, 'Planned. Booked jobs and invoiced revenue. API access terms not verified yet. Use CSV meanwhile.', '{local_service}'),
  ('stripe', 'Stripe', 'commerce', 'planned', true, false, 3, 3, 'Planned. Payments, subscriptions and refunds (billed revenue).', '{digital_products,ecommerce}'),
  ('pos', 'Point-of-sale (Square, Clover)', 'commerce', 'planned', true, false, 3, 3, 'Planned. In-store sales.', '{retail_store}');

-- create_company gains p_business_type. Drop the old signature so there is a single function.
drop function public.create_company(uuid, text, text, text, text, text);

create or replace function public.create_company(
  p_workspace_id uuid,
  p_name text,
  p_website text default null,
  p_industry text default null,
  p_country text default null,
  p_timezone text default 'UTC',
  p_business_type text default 'other'
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
  v_type text := coalesce(nullif(btrim(p_business_type), ''), 'other');
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;

  v_role := private.workspace_role(p_workspace_id);
  if v_role is null or v_role not in ('owner', 'admin', 'member') then
    raise exception 'workspace not found' using errcode = '42501';
  end if;

  if not exists (select 1 from pg_catalog.pg_timezone_names where name = v_tz) then
    raise exception 'invalid timezone' using errcode = '22023';
  end if;
  if v_type not in ('local_service', 'ecommerce', 'digital_products', 'retail_store', 'b2b_leads', 'other') then
    raise exception 'invalid business type' using errcode = '22023';
  end if;

  if not private.rate_limit_hit('create_company:' || v_uid::text, 20, 3600) then
    raise exception 'rate limit exceeded' using errcode = 'P0429';
  end if;

  select w.max_companies into v_max from public.workspaces w where w.id = p_workspace_id for update;
  select count(*) into v_count from public.companies c where c.workspace_id = p_workspace_id and c.status = 'active';
  if v_count >= v_max then
    raise exception 'company limit reached' using errcode = 'P0402';
  end if;

  insert into public.companies (workspace_id, name, website, industry, country, timezone, business_type, created_by)
  values (p_workspace_id, btrim(p_name), nullif(btrim(p_website), ''), nullif(btrim(p_industry), ''),
          nullif(upper(btrim(p_country)), ''), v_tz, v_type, v_uid)
  returning id into v_company;

  insert into public.company_settings (company_id, workspace_id) values (v_company, p_workspace_id);

  insert into public.provisioning_jobs (workspace_id, company_id, idempotency_key)
  values (p_workspace_id, v_company, 'create_dataset:' || v_company::text);

  insert into public.audit_logs (workspace_id, company_id, actor_user_id, action, target_type, target_id, metadata)
  values (p_workspace_id, v_company, v_uid, 'company.created', 'company', v_company::text,
          jsonb_build_object('name', btrim(p_name), 'business_type', v_type));
  return v_company;
end;
$$;

revoke all on function public.create_company(uuid, text, text, text, text, text, text) from public, anon;
grant execute on function public.create_company(uuid, text, text, text, text, text, text) to authenticated;
