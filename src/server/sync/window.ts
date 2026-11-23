import { addDays, localDate } from "../../lib/dates";

/**
 * Incremental sync window (complete days only, in the company's timezone):
 *  - first sync: backfill `initialBackfillDays` ending yesterday
 *  - later syncs: from (cursor + 1) but never later than (yesterday - lookback + 1),
 *    so the last `lookbackDays` are always re-fetched for late-arriving data.
 * Returns null when there is nothing to fetch.
 */
export function computeSyncWindow(opts: {
  now: Date;
  timezone: string;
  cursorDate: string | null;
  lookbackDays: number;
  initialBackfillDays: number;
}): { from: string; to: string } | null {
  const to = addDays(localDate(opts.now, opts.timezone), -1);
  if (!opts.cursorDate) {
    return { from: addDays(to, -(opts.initialBackfillDays - 1)), to };
  }
  const afterCursor = addDays(opts.cursorDate, 1);
  const lookbackStart = addDays(to, -(Math.max(1, opts.lookbackDays) - 1));
  const from = afterCursor < lookbackStart ? afterCursor : lookbackStart;
  if (from > to) return null;
  return { from, to };
}
