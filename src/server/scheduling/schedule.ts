import { addDays, localDate, zonedTimeToUtc } from "../../lib/dates";
import type { Queryable } from "../db";

// Central scheduler: ONE loop in the worker enqueues due syncs for all tenants.
// No per-tenant infrastructure schedulers. Each schedule fires daily at the
// company's local time plus a provider buffer, plus deterministic jitter so
// thousands of companies with the same local time don't hit providers at once.

export function jitterMinutes(seed: string, maxMinutes = 15): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h) % (maxMinutes + 1);
}

/** Next daily run strictly after `after`. */
export function computeNextRun(opts: {
  after: Date;
  localTime: string; // "HH:MM" or "HH:MM:SS"
  timezone: string;
  bufferMinutes: number;
  jitterSeed: string;
}): Date {
  const hhmm = opts.localTime.slice(0, 5);
  const offsetMs = (opts.bufferMinutes + jitterMinutes(opts.jitterSeed)) * 60_000;
  let day = localDate(opts.after, opts.timezone);
  for (let i = 0; i < 3; i++) {
    const candidate = new Date(zonedTimeToUtc(day, hhmm, opts.timezone).getTime() + offsetMs);
    if (candidate.getTime() > opts.after.getTime()) return candidate;
    day = addDays(day, 1);
  }
  throw new Error("could not compute next run");
}

/**
 * Enqueue sync runs for due schedules. Idempotent per (connection, scheduled
 * slot) via the idempotency key, safe with concurrent workers (SKIP LOCKED).
 */
export async function enqueueDueSyncs(db: Queryable, now: Date = new Date()): Promise<number> {
  const due = await db.query<{
    id: string;
    workspace_id: string;
    company_id: string;
    connection_id: string;
    local_time: string;
    timezone: string;
    buffer_minutes: number;
    next_run_at: Date;
    provider_id: string;
    mode: string;
    status: string;
  }>(
    `select s.id, s.workspace_id, s.company_id, s.connection_id, s.local_time::text as local_time, s.timezone,
            s.buffer_minutes, s.next_run_at, c.provider_id, c.mode, c.status
       from public.sync_schedules s
       join public.company_connections c on c.id = s.connection_id
      where s.enabled and s.frequency = 'daily' and s.next_run_at <= $1
      order by s.next_run_at
      limit 200
      for update of s skip locked`,
    [now],
  );
  let enqueued = 0;
  for (const s of due.rows) {
    const next = computeNextRun({
      after: now,
      localTime: s.local_time,
      timezone: s.timezone,
      bufferMinutes: s.buffer_minutes,
      jitterSeed: s.connection_id,
    });
    if (s.status === "connected") {
      const slot = new Date(s.next_run_at).toISOString();
      const ins = await db.query(
        `insert into public.sync_runs (workspace_id, company_id, connection_id, provider_id, trigger, idempotency_key, is_simulated)
         select $1, $2, $3, $4, 'scheduled', $5, $6
          where not exists (select 1 from public.sync_runs r where r.connection_id = $3 and r.status in ('queued', 'running'))
         on conflict (idempotency_key) do nothing`,
        [s.workspace_id, s.company_id, s.connection_id, s.provider_id, `sched:${s.connection_id}:${slot}`, s.mode === "simulated"],
      );
      enqueued += ins.rowCount ?? 0;
    }
    await db.query(`update public.sync_schedules set next_run_at = $2, last_enqueued_at = $3, updated_at = now() where id = $1`, [
      s.id,
      next,
      now,
    ]);
  }
  return enqueued;
}
