# Roadmap

Last updated: 2026-11-23. Later phases are **not built**. This file records boundaries so Phase 1 doesn't
block them.

## Phase 1.x (hardening, before any deployment)

- Verify GA4 and Google Ads live end-to-end in a dev project, and add an account picker after consent.
- First real BigQuery integration run in a dedicated dev project (with cost approval). Separate read/write service accounts.
- ~~Team invitations~~ Built: Account settings → Users (Viewer / Editor per chosen company, by email). Still to do: invitation emails sent by the platform, whole-workspace members, access limited to chosen campaigns.
- XLSX export. Retention policy, account deletion and data export (company deletion is built). Cloud Billing export reconciliation.
- Deployment design (Vercel for the web app; worker on Cloud Run jobs or Cloud Tasks) with secret management.

## Phase 2: more sources

Meta Ads, Microsoft Advertising, TikTok, Shopify (billed revenue), CRM leads. Each implements `Connector`,
gets a `connector_providers` row, and needs its own access/terms review (CONNECTORS.md). Yelp only with partner access.

## Phase 3: AI analyst

A chat/analyst may call **only** scoped, authorized server APIs (e.g. `getDashboardData` per company, with
date bounds and byte caps), never arbitrary SQL or warehouse credentials. Every call is audited and
attributed in `usage_events`. Subscriptions depend on billing (Phase 4).

## Phase 4: billing

Stripe subscriptions mapped to `workspaces.plan`. Limits from plan (companies, connections, history,
monthly bytes billed). Overages need explicit policy. `usage_events` is the metering source; actual cost comes from Cloud Billing export.

## Later

- Campaign management (budgets, launching): needs write scopes and a separate approval and safety design.
- Cross-posting (TikTok/Meta/YouTube) and the media studio: separate modules, separate storage.
- Team chat.
- Voice AI receptionist and call tracking: recordings and personal data need a privacy/consent design first.
- CRM sales automation.
