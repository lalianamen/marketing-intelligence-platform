-- Google Search Console connector (Search Analytics API, OAuth webmasters.readonly).
insert into public.connector_providers (id, display_name, category, availability, supports_oauth, supports_simulation, default_lookback_days, finalization_days, description, relevant_for)
values ('google_search_console', 'Google Search Console', 'seo', 'requires_admin_setup', true, false, 4, 3,
        'Clicks, impressions and position in Google Search by query, page, country and device (Search Analytics API).',
        '{local_service,retail_store,b2b_leads,digital_products,ecommerce,other}')
on conflict (id) do update set display_name = excluded.display_name, category = excluded.category, availability = excluded.availability,
  supports_oauth = excluded.supports_oauth, supports_simulation = excluded.supports_simulation,
  default_lookback_days = excluded.default_lookback_days, finalization_days = excluded.finalization_days,
  description = excluded.description, relevant_for = excluded.relevant_for;
