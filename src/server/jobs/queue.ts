import type { Queryable } from "../db";
import { redact } from "../crypto";

// Durable PostgreSQL-backed queue for provisioning_jobs and sync_runs.
//  * claim: FOR UPDATE SKIP LOCKED + lease (locked_until) → safe with many workers
//  * fencing: completion/failure only applies while locked_by = this worker
//  * crash recovery: reconcile() re-queues expired leases
// The same domain functions can later be driven by Cloud Tasks / Cloud Run jobs:
// only claim/lease would be replaced by the push delivery.

export type JobTable = "provisioning_jobs" | "sync_runs";
const JOB_TYPE: Record<JobTable, "provisioning" | "sync"> = { provisioning_jobs: "provisioning", sync_runs: "sync" };

export interface ClaimedJob {
  id: string;
  workspace_id: string;
  company_id: string;
  attempts: number;
  max_attempts: number;
  [k: string]: unknown;
}

/** Fairness: one company never occupies more than this many workers at once. */
export const MAX_RUNNING_PER_COMPANY = 2;

export interface ClaimOptions {
  /** For sync_runs: max concurrently running runs per provider (rate limiting). */
  maxRunningPerProvider?: number;
}

export async function claimJob(
  db: Queryable,
  table: JobTable,
  workerId: string,
  leaseSeconds: number,
  opts: ClaimOptions = {},
): Promise<ClaimedJob | null> {
  const extra =
    table === "sync_runs"
      ? `and not exists (select 1 from public.sync_runs r2 where r2.connection_id = j.connection_id and r2.status = 'running')
         and (select count(*) from public.sync_runs r3 where r3.provider_id = j.provider_id and r3.status = 'running') < $3
         and (select count(*) from public.sync_runs r4 where r4.company_id = j.company_id and r4.status = 'running') < ${MAX_RUNNING_PER_COMPANY}`
      : "and $3::int is not null";
  const res = await db.query<ClaimedJob>(
    `update public.${table} t
        set status = 'running', attempts = t.attempts + 1, locked_by = $1,
            locked_until = now() + make_interval(secs => $2)
            ${table === "sync_runs" ? ", started_at = coalesce(t.started_at, now())" : ", updated_at = now()"}
      where t.id = (
        select j.id from public.${table} j
         where j.status = 'queued' and j.run_after <= now() ${extra}
         order by ${table === "sync_runs" ? "j.priority, " : ""}j.run_after
         for update skip locked
         limit 1)
     returning t.*`,
    [workerId, leaseSeconds, opts.maxRunningPerProvider ?? 4],
  );
  const job = res.rows[0];
  if (!job) return null;
  await db.query(
    `insert into public.job_attempts (job_type, job_id, workspace_id, company_id, attempt, worker_id, status)
     values ($1, $2, $3, $4, $5, $6, 'running')`,
    [JOB_TYPE[table], job.id, job.workspace_id, job.company_id, job.attempts, workerId],
  );
  return job;
}

export async function completeJob(
  db: Queryable,
  table: JobTable,
  job: ClaimedJob,
  workerId: string,
  extraSet: Record<string, unknown> = {},
): Promise<boolean> {
  const keys = Object.keys(extraSet);
  const sets = keys.map((k, i) => `${assertColumn(k)} = $${i + 3}`);
  const res = await db.query(
    `update public.${table} set status = 'succeeded', locked_by = null, locked_until = null,
        ${table === "sync_runs" ? "finished_at = now()" : "finished_at = now(), updated_at = now()"}
        ${sets.length ? ", " + sets.join(", ") : ""}
      where id = $1 and locked_by = $2 and status = 'running'`,
    [job.id, workerId, ...keys.map((k) => extraSet[k])],
  );
  await finishAttempt(db, table, job, workerId, "succeeded");
  return (res.rowCount ?? 0) > 0;
}

/** Exponential backoff with full jitter, capped. */
export function backoffSeconds(attempt: number, baseSeconds = 30, capSeconds = 3600, rand: () => number = Math.random): number {
  const exp = Math.min(capSeconds, baseSeconds * 2 ** Math.max(0, attempt - 1));
  return Math.round(exp / 2 + rand() * (exp / 2));
}

export interface FailOutcome {
  status: "queued" | "failed" | "dead";
  retryInSeconds?: number;
}

export async function failJob(
  db: Queryable,
  table: JobTable,
  job: ClaimedJob,
  workerId: string,
  err: { code: string; message: string; retryable: boolean },
): Promise<FailOutcome> {
  const message = redact(err.message);
  let outcome: FailOutcome;
  if (!err.retryable) outcome = { status: "failed" };
  else if (job.attempts >= job.max_attempts) outcome = { status: "dead" };
  else outcome = { status: "queued", retryInSeconds: backoffSeconds(job.attempts) };

  const errorCols =
    table === "sync_runs" ? "error_code = $4, error_message = $5" : "last_error_code = $4, last_error = $5, updated_at = now()";
  await db.query(
    `update public.${table}
        set status = $3, locked_by = null, locked_until = null, ${errorCols},
            run_after = case when $3 = 'queued' then now() + make_interval(secs => $6) else run_after end,
            finished_at = case when $3 = 'queued' then null else now() end
      where id = $1 and locked_by = $2 and status = 'running'`,
    [job.id, workerId, outcome.status, err.code, message, outcome.retryInSeconds ?? 0],
  );
  await finishAttempt(db, table, job, workerId, "failed", err.code, message);
  return outcome;
}

async function finishAttempt(
  db: Queryable,
  table: JobTable,
  job: ClaimedJob,
  workerId: string,
  status: "succeeded" | "failed",
  code?: string,
  message?: string,
): Promise<void> {
  await db.query(
    `update public.job_attempts set status = $5, error_code = $6, error_message = $7, finished_at = now()
      where job_type = $1 and job_id = $2 and attempt = $3 and worker_id = $4 and status = 'running'`,
    [JOB_TYPE[table], job.id, job.attempts, workerId, status, code ?? null, message ?? null],
  );
}

/** Re-queue jobs whose worker died (lease expired). Returns number recovered. */
export async function recoverExpiredLeases(db: Queryable, table: JobTable): Promise<number> {
  const res = await db.query<{ id: string; status: string }>(
    `update public.${table}
        set status = case when attempts >= max_attempts then 'dead' else 'queued' end,
            locked_by = null, locked_until = null,
            run_after = now(),
            ${table === "sync_runs" ? "error_code = 'lease_expired', error_message = 'worker stopped before finishing; retried'" : "last_error_code = 'lease_expired', last_error = 'worker stopped before finishing; retried', updated_at = now()"}
      where status = 'running' and locked_until < now()
     returning id, status`,
  );
  if (res.rows.length) {
    await db.query(
      `update public.job_attempts set status = 'abandoned', error_code = 'lease_expired', finished_at = now()
        where job_type = $1 and status = 'running' and job_id = any($2::uuid[])`,
      [JOB_TYPE[table], res.rows.map((r) => r.id)],
    );
  }
  return res.rows.length;
}

/** Extend the lease of a long-running job (heartbeat). */
export async function heartbeat(db: Queryable, table: JobTable, jobId: string, workerId: string, leaseSeconds: number): Promise<boolean> {
  const res = await db.query(
    `update public.${table} set locked_until = now() + make_interval(secs => $3)
      where id = $1 and locked_by = $2 and status = 'running'`,
    [jobId, workerId, leaseSeconds],
  );
  return (res.rowCount ?? 0) > 0;
}

function assertColumn(c: string): string {
  if (!/^[a-z_]{1,40}$/.test(c)) throw new Error("bad column");
  return c;
}

/**
 * Place in the line for queued sync runs (1 = next), counting only work that is
 * ahead by the router's order (priority, then run_after). Reveals counts only.
 */
export async function queuePositions(db: Queryable, runIds: string[]): Promise<Map<string, number>> {
  if (runIds.length === 0) return new Map();
  const r = await db.query<{ id: string; ahead: number }>(
    `select q.id, (select count(*)::int from public.sync_runs o
                     where o.status = 'queued' and o.id <> q.id
                       and (o.priority, o.run_after) < (q.priority, q.run_after)) as ahead
       from public.sync_runs q where q.id = any($1::uuid[]) and q.status = 'queued'`,
    [runIds],
  );
  return new Map(r.rows.map((x) => [x.id, x.ahead + 1]));
}
