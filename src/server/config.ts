// Server-side configuration. Never import this from client components.
// All values come from environment variables; nothing secret is hardcoded.

export type WarehouseMode = "local" | "bigquery";

export interface ServerConfig {
  appUrl: string;
  supabaseUrl: string;
  supabaseAnonKey: string;
  supabaseServiceRoleKey: string | undefined;
  databaseUrl: string;
  warehouseMode: WarehouseMode;
  warehouseLocalUrl: string;
  datasetPrefix: string;
  bigquery: {
    projectId: string | undefined;
    location: string;
    maxBytesBilled: number;
    billingApproved: boolean;
    datasetsPerProject: number;
  };
  tokenEncryptionKey: string | undefined;
  google: {
    clientId: string | undefined;
    clientSecret: string | undefined;
    redirectUri: string;
    adsDeveloperToken: string | undefined;
    /** Show Google Ads as connectable. Off until Google approves API access for real (non-test) accounts. */
    adsEnabled: boolean;
    adsLoginCustomerId: string | undefined;
    adsApiVersion: string;
  };
  /** Bing Webmaster Tools "Sign in with Bing" (OAuth client registered in Bing Webmaster → Settings → API Access). */
  bing: {
    clientId: string | undefined;
    clientSecret: string | undefined;
    redirectUri: string;
  };
  initialBackfillDays: number;
}

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`Invalid number in ${name}`);
  return n;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const mode = (env.WAREHOUSE_MODE ?? "local") as WarehouseMode;
  if (mode !== "local" && mode !== "bigquery") {
    throw new Error("WAREHOUSE_MODE must be 'local' or 'bigquery'");
  }
  const prefix = (env.DATASET_PREFIX ?? "mip_dev").toLowerCase();
  if (!/^[a-z][a-z0-9_]{0,30}$/.test(prefix)) {
    throw new Error("DATASET_PREFIX must match ^[a-z][a-z0-9_]{0,30}$");
  }
  const appUrl = env.APP_URL ?? "http://127.0.0.1:3000";
  return {
    appUrl,
    supabaseUrl: env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321",
    supabaseAnonKey: env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "",
    supabaseServiceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY,
    databaseUrl: env.DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
    warehouseMode: mode,
    warehouseLocalUrl:
      env.WAREHOUSE_LOCAL_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/mip_warehouse",
    datasetPrefix: prefix,
    bigquery: {
      projectId: env.BIGQUERY_PROJECT_ID || undefined,
      location: env.BIGQUERY_LOCATION ?? "US",
      maxBytesBilled: int("BIGQUERY_MAX_BYTES_BILLED", 100 * 1024 * 1024),
      billingApproved: env.BIGQUERY_BILLING_APPROVED === "true",
      datasetsPerProject: int("BIGQUERY_DATASETS_PER_PROJECT", 500),
    },
    tokenEncryptionKey: env.TOKEN_ENCRYPTION_KEY || undefined,
    google: {
      clientId: env.GOOGLE_OAUTH_CLIENT_ID || undefined,
      clientSecret: env.GOOGLE_OAUTH_CLIENT_SECRET || undefined,
      redirectUri: env.GOOGLE_OAUTH_REDIRECT_URI ?? `${appUrl}/api/oauth/google/callback`,
      adsDeveloperToken: env.GOOGLE_ADS_DEVELOPER_TOKEN || undefined,
      adsEnabled: env.GOOGLE_ADS_ENABLED === "true",
      adsLoginCustomerId: env.GOOGLE_ADS_LOGIN_CUSTOMER_ID || undefined,
      adsApiVersion: env.GOOGLE_ADS_API_VERSION ?? "v26",
    },
    bing: {
      clientId: env.BING_OAUTH_CLIENT_ID || undefined,
      clientSecret: env.BING_OAUTH_CLIENT_SECRET || undefined,
      redirectUri: env.BING_OAUTH_REDIRECT_URI ?? `${appUrl}/api/oauth/bing/callback`,
    },
    initialBackfillDays: int("INITIAL_BACKFILL_DAYS", 30),
  };
}

/** Whether Google OAuth for GA4 / Google Ads is configured by an administrator. */
export function googleOAuthConfigured(cfg: ServerConfig): boolean {
  return Boolean(cfg.google.clientId && cfg.google.clientSecret && cfg.tokenEncryptionKey);
}

/** Whether "Sign in with Bing" is configured (otherwise Bing connects with an API key). */
export function bingOAuthConfigured(cfg: ServerConfig): boolean {
  return Boolean(cfg.bing.clientId && cfg.bing.clientSecret && cfg.tokenEncryptionKey);
}
