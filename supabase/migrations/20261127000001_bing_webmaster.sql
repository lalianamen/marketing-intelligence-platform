-- Bing Webmaster Tools connector (Bing Webmaster API, the user's API key).
insert into public.connector_providers (id, display_name, category, availability, supports_oauth, supports_simulation, default_lookback_days, finalization_days, description, relevant_for)
values ('bing_webmaster', 'Bing Webmaster Tools', 'seo', 'available', false, false, 14, 3,
        'Clicks and impressions on Bing per day, plus top search queries or pages (Bing Webmaster API, API key).',
        '{local_service,retail_store,b2b_leads,digital_products,ecommerce,other}')
on conflict (id) do update set display_name = excluded.display_name, category = excluded.category, availability = excluded.availability,
  supports_oauth = excluded.supports_oauth, supports_simulation = excluded.supports_simulation,
  default_lookback_days = excluded.default_lookback_days, finalization_days = excluded.finalization_days,
  description = excluded.description, relevant_for = excluded.relevant_for;
