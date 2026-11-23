# Deployment (hosted platform)

Last updated: 2026-11-24. **Status: prepared, not yet performed.** Nothing here has been run against
real Vercel / Supabase cloud / Google Cloud accounts yet. Each step will be verified when it is executed.

## Target

| Part | Service | Plan |
|---|---|---|
| Web app + background jobs | Vercel (Next.js functions, `after()`, Vercel Cron) | Hobby (free) to start |
| Accounts, tenancy, jobs, registry | Supabase (Postgres + Auth + email) | Free to start (500 MB, pauses after 1 week inactive) |
| Analytics warehouse | Google BigQuery, **one platform project**, dataset per company | Billing-enabled project owned by the platform |

End users never touch any of this: they sign up, add companies and connect their own marketing accounts through official
consent screens. The platform owner sets the services up **once**.

## How background work runs when hosted

- After a user action (add company, import CSV, "Update now", connect a source), the server action calls `kickJobs()`.
  Next.js `after()` then processes the queue for up to ~25 s once the response has been sent.
- `vercel.json` schedules `GET /api/jobs/run` daily at 16:00 UTC, protected by `CRON_SECRET`. The run handles lease recovery,
  reconciliation, enqueuing of due daily syncs and draining. On the Hobby plan Vercel Cron can run only daily (verify current limits).
  A higher plan or an external scheduler can call the same endpoint hourly so backoff retries happen sooner.
- The same domain code still works with a dedicated worker (`npm run worker`, `RUN_JOBS_INLINE=false`).

## Step 1: Supabase project (platform owner)

1. Create a new project (do not reuse an unrelated project). Region close to users, e.g. `us-west-1`.
2. Apply `supabase/migrations/*` in order.
3. Auth settings: Site URL = the Vercel URL; Redirect URLs = `<site>/**`; email confirmations on; minimum password
   length 10, letters + digits; email templates from `supabase/templates/*.html` (they use `token_hash`).
4. Configure a real SMTP sender before inviting real users (Supabase's built-in email has strict hourly limits).

## Step 2: Vercel project

1. Import the GitHub repo `lalianamen/marketing-intelligence-platform` (framework: Next.js).
2. Environment variables (Production), entered in Vercel, **never committed**:
   `APP_URL`, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`,
   `DATABASE_URL` (Supabase pooled connection string, `sslmode=require`), `WAREHOUSE_MODE`, `WAREHOUSE_LOCAL_URL`
   (= `DATABASE_URL` while in simulated mode), `DATASET_PREFIX=mip_prod`, `TOKEN_ENCRYPTION_KEY`, `CRON_SECRET`,
   `RUN_JOBS_INLINE=true`, and for BigQuery: `BIGQUERY_PROJECT_ID`, `BIGQUERY_LOCATION`, `BIGQUERY_BILLING_APPROVED`,
   `GCP_WORKLOAD_IDENTITY_PROVIDER`, `GCP_SERVICE_ACCOUNT_EMAIL`.
3. Enable Vercel OIDC federation for the project (team issuer mode).

## Step 3: BigQuery for the platform (platform owner, once)

1. Google Cloud project (e.g. `mip-prod`) with **billing enabled**, a budget alert, and the BigQuery API enabled.
2. In Cloud Shell, adapting names. **Verify the Vercel OIDC issuer/audience/subject format in Vercel's current docs
   before running.**

```bash
PROJECT_ID=mip-prod
PROJECT_NUMBER=$(gcloud projects describe $PROJECT_ID --format='value(projectNumber)')
TEAM_SLUG=<vercel-team-slug>
VERCEL_PROJECT=marketing-intelligence-platform
gcloud services enable bigquery.googleapis.com iam.googleapis.com iamcredentials.googleapis.com sts.googleapis.com --project $PROJECT_ID
gcloud iam service-accounts create mip-platform --project $PROJECT_ID --display-name "Marketing Intelligence platform"
SA=mip-platform@$PROJECT_ID.iam.gserviceaccount.com
# create datasets + run jobs; nothing else
gcloud projects add-iam-policy-binding $PROJECT_ID --member serviceAccount:$SA --role roles/bigquery.jobUser
gcloud projects add-iam-policy-binding $PROJECT_ID --member serviceAccount:$SA --role roles/bigquery.dataEditor
gcloud iam workload-identity-pools create vercel --project $PROJECT_ID --location global --display-name Vercel
gcloud iam workload-identity-pools providers create-oidc vercel --project $PROJECT_ID --location global \
  --workload-identity-pool vercel --issuer-uri "https://oidc.vercel.com/$TEAM_SLUG" \
  --allowed-audiences "https://vercel.com/$TEAM_SLUG" \
  --attribute-mapping "google.subject=assertion.sub"
gcloud iam service-accounts add-iam-policy-binding $SA --project $PROJECT_ID --role roles/iam.workloadIdentityUser \
  --member "principal://iam.googleapis.com/projects/$PROJECT_NUMBER/locations/global/workloadIdentityPools/vercel/subject/owner:$TEAM_SLUG:project:$VERCEL_PROJECT:environment:production"
echo "GCP_WORKLOAD_IDENTITY_PROVIDER=projects/$PROJECT_NUMBER/locations/global/workloadIdentityPools/vercel/providers/vercel"
echo "GCP_SERVICE_ACCOUNT_EMAIL=$SA"
```

3. Set `WAREHOUSE_MODE=bigquery`, `BIGQUERY_PROJECT_ID`, `BIGQUERY_LOCATION` and, after the owner approves billing,
   `BIGQUERY_BILLING_APPROVED=true`. Redeploy. New companies then get real datasets.
   Companies created earlier stay in the simulated warehouse (the registry records the provider per company).

No service-account key files are created or stored anywhere.

## Step 4: Verification checklist (to perform after deployment)

- [ ] Sign up with a real email, confirm, log in, log out
- [ ] Add a company; its data space reaches *Ready*; in BigQuery mode the dataset `mip_prod_c_<id>` exists with labels
- [ ] Upload the sample CSV; KPIs match; export works
- [ ] `GET /api/jobs/run` without the secret returns 401
- [ ] `npm run check:bundle` passes on the deployed build; no secrets in Vercel logs
