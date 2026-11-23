-- The account the user wants to connect (GA4 property ID / Google Ads customer ID),
-- captured before the redirect to Google so the callback can bind the grant to it.
alter table public.oauth_states
  add column external_account_id text not null default '' check (char_length(external_account_id) <= 64);
