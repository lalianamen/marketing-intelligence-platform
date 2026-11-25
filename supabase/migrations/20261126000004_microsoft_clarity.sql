-- Microsoft Clarity connector (Data Export API, project API token).
update public.connector_providers
set availability = 'available', supports_oauth = false, supports_simulation = false,
    default_lookback_days = 0, finalization_days = 0,
    description = 'How visitors behave on the site (sessions, scroll depth, engagement time, rage / dead clicks, script errors) through the Clarity Data Export API. Last 24 hours per day; no history.',
    relevant_for = '{local_service,retail_store,b2b_leads,digital_products,ecommerce,other}'
where id = 'microsoft_clarity';
