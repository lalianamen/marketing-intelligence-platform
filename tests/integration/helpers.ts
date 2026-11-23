import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import pg from "pg";
import { loadConfig, type ServerConfig } from "@/server/config";
import { getWarehouse } from "@/server/warehouse";
import { ensureLocalWarehouseDatabase, LocalWarehouse } from "@/server/warehouse/local";
import type { Warehouse, WarehouseProvider } from "@/server/warehouse/types";
import { startup, type WorkerDeps } from "@/worker/worker";

export const cfg: ServerConfig = loadConfig();
export const url = cfg.supabaseUrl;
export const anonKey = cfg.supabaseAnonKey;

export function anonClient(): SupabaseClient {
  return createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
}

export function adminClient(): SupabaseClient {
  return createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });
}

export const pool = new pg.Pool({ connectionString: cfg.databaseUrl, max: 5 });

export interface TestUser {
  id: string;
  email: string;
  client: SupabaseClient;
  workspaceId: string;
}

/** Confirmed user (created through the Auth admin API) with a bootstrapped workspace. */
export async function createVerifiedUser(label = "u"): Promise<TestUser> {
  const email = `${label}-${randomUUID().slice(0, 8)}@example.test`;
  const password = `Pw-${randomUUID()}1a`;
  const { data, error } = await adminClient().auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw error;
  const client = anonClient();
  const s = await client.auth.signInWithPassword({ email, password });
  if (s.error) throw s.error;
  const ws = await client.rpc("bootstrap_workspace", { p_name: `${label} workspace` });
  if (ws.error) throw ws.error;
  return { id: data.user!.id, email, client, workspaceId: ws.data as string };
}

export async function createCompany(u: TestUser, name: string, tz = "UTC"): Promise<string> {
  const r = await u.client.rpc("create_company", { p_workspace_id: u.workspaceId, p_name: name, p_timezone: tz });
  if (r.error) throw r.error;
  return r.data as string;
}

let localWh: LocalWarehouse | undefined;
export async function localWarehouse(): Promise<LocalWarehouse> {
  if (!localWh) {
    await ensureLocalWarehouseDatabase(cfg.databaseUrl, cfg.warehouseLocalUrl);
    localWh = new LocalWarehouse(cfg.warehouseLocalUrl);
  }
  return localWh;
}

export async function workerDeps(overrides: Partial<WorkerDeps> = {}): Promise<WorkerDeps> {
  const wh = await localWarehouse();
  const deps: WorkerDeps = {
    pool,
    cfg,
    workerId: `test-worker-${randomUUID().slice(0, 6)}`,
    getWarehouse: async (p: WarehouseProvider): Promise<Warehouse> => (p === "local" ? wh : getWarehouse(p, cfg)),
    log: () => undefined,
    ...overrides,
  };
  await startup(deps);
  return deps;
}

/** Make every queued job immediately runnable (skip backoff waits in tests). */
export async function makeQueuedRunnable(): Promise<void> {
  await pool.query(`update public.provisioning_jobs set run_after = now() where status = 'queued'`);
  await pool.query(`update public.sync_runs set run_after = now() where status = 'queued'`);
}

/** Isolate tests from rows of other test files: only touch our companies. */
export async function onlyCompanies(ids: string[]): Promise<void> {
  await pool.query(
    `update public.provisioning_jobs set status = 'failed', last_error = 'isolated by test' where status = 'queued' and not (company_id = any($1::uuid[]))`,
    [ids],
  );
  await pool.query(
    `update public.sync_runs set status = 'cancelled' where status = 'queued' and not (company_id = any($1::uuid[]))`,
    [ids],
  );
  await pool.query(`update public.sync_schedules set enabled = false where not (company_id = any($1::uuid[]))`, [ids]);
}
