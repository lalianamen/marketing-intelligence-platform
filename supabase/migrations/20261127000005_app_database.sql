-- "Your app's database" connector: reads the schema marketing_intel in the
-- customer's own Supabase database with a read-only login (mi_reader).
insert into public.connector_providers (id, display_name, category, availability, supports_oauth, supports_simulation, default_lookback_days, finalization_days, description, relevant_for)
values ('app_database', 'Your app''s database (Supabase)', 'analytics', 'available', false, false, 2, 1,
        'Sign-ups, trials, purchases and visits from your own app''s Supabase database (read-only access to one schema). Powers the Funnel.',
        '{digital_products,ecommerce,b2b_leads,other}')
on conflict (id) do update set display_name = excluded.display_name, category = excluded.category, availability = excluded.availability,
  supports_oauth = excluded.supports_oauth, supports_simulation = excluded.supports_simulation,
  default_lookback_days = excluded.default_lookback_days, finalization_days = excluded.finalization_days,
  description = excluded.description, relevant_for = excluded.relevant_for;
