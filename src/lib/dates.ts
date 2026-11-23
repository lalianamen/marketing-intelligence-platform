// Calendar-date helpers. Metric dates are plain calendar days (YYYY-MM-DD) in
// the SOURCE's reporting timezone; they are never shifted between timezones
// (a daily aggregate cannot be re-bucketed without hourly data).

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isValidDate(s: string): boolean {
  const m = DATE_RE.exec(s);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]);
}

export function addDays(date: string, n: number): string {
  const m = DATE_RE.exec(date);
  if (!m) throw new Error(`invalid date ${date}`);
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + n));
  return d.toISOString().slice(0, 10);
}

export function daysBetweenInclusive(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000) + 1;
}

export function enumerateDates(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** The calendar date at instant `now` in timezone `tz`. */
export function localDate(now: Date, tz: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** Offset (ms) of tz from UTC at instant `at`. */
function tzOffsetMs(at: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(at);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return asUtc - Math.floor(at.getTime() / 1000) * 1000;
}

/** UTC instant of local wall-clock time `date hh:mm` in `tz` (DST-aware). */
export function zonedTimeToUtc(date: string, hhmm: string, tz: string): Date {
  const [h, mi] = hhmm.split(":").map(Number);
  const m = DATE_RE.exec(date);
  if (!m || h === undefined || mi === undefined) throw new Error("invalid local time");
  const guess = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), h, mi);
  let ts = guess - tzOffsetMs(new Date(guess), tz);
  // Second pass handles DST transitions between guess and result.
  ts = guess - tzOffsetMs(new Date(ts), tz);
  return new Date(ts);
}

/** Previous period of equal length immediately before [from, to]. */
export function previousPeriod(from: string, to: string): { from: string; to: string } {
  const len = daysBetweenInclusive(from, to);
  return { from: addDays(from, -len), to: addDays(from, -1) };
}
