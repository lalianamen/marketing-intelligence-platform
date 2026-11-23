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
    const client = new BigQuery({ projectId: cfg.bigquery.projectId });
    wh = new BigQueryWarehouse(client, {
      maxBytesBilled: cfg.bigquery.maxBytesBilled,
      billingApproved: cfg.bigquery.billingApproved,
    });
  }
  cache.set(key, wh);
  return wh;
}

export function setWarehouseForTests(provider: WarehouseProvider, wh: Warehouse, cfg: ServerConfig = loadConfig()): void {
  const key = provider === "local" ? `local:${cfg.warehouseLocalUrl}` : `bigquery`;
  cache.set(key, wh);
}

export function clearWarehouseCache(): void {
  cache.clear();
}

export * from "./types";
