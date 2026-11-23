import { loadConfig, type ServerConfig } from "../config";
import { BigQueryWarehouse } from "./bigquery";
import { LocalWarehouse } from "./local";
import type { Warehouse, WarehouseProvider } from "./types";

const cache = new Map<string, Warehouse>();

/** Returns the warehouse adapter for a provider recorded in the resource registry. */
export async function getWarehouse(provider: WarehouseProvider, cfg: ServerConfig = loadConfig()): Promise<Warehouse> {
  const key = provider === "local" ? `local:${cfg.warehouseLocalUrl}` : `bigquery`;
  const hit = cache.get(key);
  if (hit) return hit;
  let wh: Warehouse;
  if (provider === "local") {
    wh = new LocalWarehouse(cfg.warehouseLocalUrl);
  } else {
    // Loaded lazily so local mode never needs Google credentials.
    const { BigQuery } = await import("@google-cloud/bigquery");
    // Application Default Credentials (no key material in code or browser).
    const authClient = await workloadIdentityClient();
    const client = new BigQuery({ projectId: cfg.bigquery.projectId, ...(authClient ? { authClient } : {}) });
    wh = new BigQueryWarehouse(client, {
      maxBytesBilled: cfg.bigquery.maxBytesBilled,
      billingApproved: cfg.bigquery.billingApproved,
    });
  }
  cache.set(key, wh);
  return wh;
}

/**
 * Keyless Google Cloud auth from Vercel: Vercel's OIDC token is exchanged for a
 * short-lived Google token through Workload Identity Federation, impersonating
 * a least-privilege service account. Without these env vars, Application
 * Default Credentials are used (local `gcloud auth application-default login`).
 */
export function workloadIdentityConfig(env: Record<string, string | undefined> = process.env) {
  const provider = env.GCP_WORKLOAD_IDENTITY_PROVIDER; // projects/<number>/locations/global/workloadIdentityPools/<pool>/providers/<provider>
  const serviceAccount = env.GCP_SERVICE_ACCOUNT_EMAIL;
  if (!provider || !serviceAccount) return null;
  if (!/^projects\/\d+\/locations\/global\/workloadIdentityPools\/[a-z0-9-]+\/providers\/[a-z0-9-]+$/.test(provider)) {
    throw new Error("GCP_WORKLOAD_IDENTITY_PROVIDER has an unexpected format");
  }
  if (!/^[a-z0-9-]+@[a-z0-9-]+\.iam\.gserviceaccount\.com$/.test(serviceAccount)) {
    throw new Error("GCP_SERVICE_ACCOUNT_EMAIL has an unexpected format");
  }
  return {
    type: "external_account" as const,
    audience: `//iam.googleapis.com/${provider}`,
    subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
    token_url: "https://sts.googleapis.com/v1/token",
    service_account_impersonation_url: `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${serviceAccount}:generateAccessToken`,
  };
}

async function workloadIdentityClient() {
  const conf = workloadIdentityConfig();
  if (!conf) return null;
  const [{ IdentityPoolClient }, { getVercelOidcToken }] = await Promise.all([import("google-auth-library"), import("@vercel/oidc")]);
  return new IdentityPoolClient({
    ...conf,
    subject_token_supplier: { getSubjectToken: () => getVercelOidcToken() },
  });
}

export function setWarehouseForTests(provider: WarehouseProvider, wh: Warehouse, cfg: ServerConfig = loadConfig()): void {
  const key = provider === "local" ? `local:${cfg.warehouseLocalUrl}` : `bigquery`;
  cache.set(key, wh);
}

export function clearWarehouseCache(): void {
  cache.clear();
}

export * from "./types";
