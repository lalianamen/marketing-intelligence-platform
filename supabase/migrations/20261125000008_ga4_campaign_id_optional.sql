-- GA4 "sessionCampaignId" became an optional column (it was always requested).
-- Existing live GA4 connectors keep it, so their tables do not change until the
-- user removes it and saves.
update public.company_connections
set settings = jsonb_set(
  coalesce(settings, '{}'::jsonb),
  '{ga4_reports}',
  coalesce(settings->'ga4_reports', '[]'::jsonb) || '["sessionCampaignId"]'::jsonb
)
where provider_id = 'ga4'
  and mode = 'live'
  and activated_at is not null
  and not coalesce(settings->'ga4_reports', '[]'::jsonb) ? 'sessionCampaignId';
