import pg from "pg";
import { loadConfig } from "./config";

// Privileged PostgreSQL pool for trusted server code and the worker.
// It bypasses RLS, so every caller MUST perform its own authorization
// (see src/server/auth/authz.ts) before touching tenant data.

let pool: pg.Pool | undefined;

// Return DATE columns as 'YYYY-MM-DD' strings (no timezone shifting).
pg.types.setTypeParser(1082, (v) => v);
// NUMERIC as JS number (metrics are well within double precision for Phase 1).
pg.types.setTypeParser(1700, (v) => (v === null ? null : Number(v)));
// BIGINT as number
pg.types.setTypeParser(20, (v) => (v === null ? null : Number(v)));

export function getPool(): pg.Pool {
  if (!pool) {
    pool = new pg.Pool({ connectionString: loadConfig().databaseUrl, max: 10 });
  }
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}

export async function withTransaction<T>(fn: (client: pg.PoolClient) => Promise<T>, p: pg.Pool = getPool()): Promise<T> {
  const client = await p.connect();
  try {
    await client.query("begin");
    const result = await fn(client);
    await client.query("commit");
    return result;
  } catch (err) {
    await client.query("rollback").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export type Queryable = pg.Pool | pg.PoolClient;
