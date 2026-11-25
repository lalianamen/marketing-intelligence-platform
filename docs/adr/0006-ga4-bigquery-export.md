# ADR-0006: GA4 full data through Google's BigQuery export

Status: accepted · 2026-11-25

## Context
The GA4 Data API returns at most 9 dimensions and 10 metrics per request, so one table cannot hold every breakdown
(traffic source × device × location × landing page …). Separate reports cannot be joined back into one row: reports
have no visit id. GA4's own BigQuery export writes every event daily (free for standard properties up to 1M events
per day) and has no such limit.

## Decision
- A GA4 connector can turn on "Full data". GA4 then exports daily into the **platform's** Cloud project, dataset
  `analytics_<property>` (location = `BIGQUERY_LOCATION`).
- Google lets only an owner of the receiving project create the link (Owner, or: `resourcemanager.projects.get`,
  `getIamPolicy`, `setIamPolicy`, `serviceusage.services.get`, `serviceusage.services.enable`). Customers must not get
  rights on the platform project, so the platform service account creates the link:
  1. the user consents on Google's screen to `analytics.readonly`, `analytics.edit`, `analytics.manage.users`
     (needs the Administrator role on the property);
  2. the user's token adds the platform service account to the property as Editor;
  3. the service account creates the daily export link (no streaming, no advertising ids);
  4. the user's token removes the service account again — always, also when step 3 fails.
- The user's grant is stored encrypted (AAD `ga4export:<connection>`) only to remove the link later; turning off or
  deleting the connector removes the link in GA4 and deletes `analytics_<property>`.
- Sync: days present in the export (`events_YYYYMMDD`) are built from events (visits = `user_pseudo_id` +
  `ga_session_id`, attribution from `session_traffic_source_last_click.cross_channel_campaign`), any number of columns;
  other days (before the export started, or not exported yet) use the Data API as before. With more than 9 breakdowns,
  days outside the export are not loaded and the run says so.
- A change of columns with full data on reloads every exported day (up to 400), not only 30 days.

## Consequences
- Numbers can differ slightly from GA4 reports (reports use estimates and hide small values).
- The export starts on the day of linking; GA4 does not export the past.
- The platform service account holds `setIamPolicy` on the platform project (required by Google for linking). This
  is a powerful permission; it is limited to the platform project and recorded here.
- Public launch needs Google's OAuth verification for the sensitive Analytics scopes, a privacy policy and terms
  covering processing of event-level (pseudonymous) data on the customer's behalf.
