-- Meta Ads connector (Marketing API Insights, "Connect with Facebook", ads_read).
update public.connector_providers
set availability = 'available', supports_oauth = true, supports_simulation = false,
    default_lookback_days = 7, finalization_days = 7,
    description = 'Facebook and Instagram ads: spend, impressions, clicks, purchases, leads and purchase value per campaign and day (Meta Marketing API, Connect with Facebook).',
    relevant_for = '{local_service,retail_store,b2b_leads,digital_products,ecommerce,other}'
where id = 'meta_ads';
