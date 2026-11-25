-- Stripe connector (balance transactions, restricted read-only key).
update public.connector_providers
set availability = 'available', supports_oauth = false, supports_simulation = false,
    default_lookback_days = 3, finalization_days = 3,
    description = 'Money actually received (payments, refunds, disputes, fees, payouts) from Stripe balance transactions, with a restricted read-only key. Feeds billed revenue.',
    relevant_for = '{local_service,retail_store,b2b_leads,digital_products,ecommerce,other}'
where id = 'stripe';
