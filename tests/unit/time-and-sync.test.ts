import { describe, expect, it } from "vitest";
import { addDays, daysBetweenInclusive, localDate, previousPeriod, zonedTimeToUtc } from "@/lib/dates";
import { computeNextRun, jitterMinutes } from "@/server/scheduling/schedule";
import { computeSyncWindow } from "@/server/sync/window";
import { dataStatusFor, normalizeProviderRecords, rowKey } from "@/server/ingestion/normalize";
import { backoffSeconds } from "@/server/jobs/queue";
import { resolveRange } from "@/server/metrics/dashboard";

describe("date helpers", () => {
  it("localDate respects timezone boundaries", () => {
    const instant = new Date("2026-11-23T06:30:00Z"); // 22:30 previous day in Los Angeles
    expect(localDate(instant, "America/Los_Angeles")).toBe("2026-11-22");
    expect(localDate(instant, "UTC")).toBe("2026-11-23");
    expect(localDate(instant, "Asia/Tokyo")).toBe("2026-11-23");
  });

  it("zonedTimeToUtc handles DST (Los Angeles)", () => {
    expect(zonedTimeToUtc("2026-07-01", "06:00", "America/Los_Angeles").toISOString()).toBe("2026-07-01T13:00:00.000Z");
    expect(zonedTimeToUtc("2026-12-01", "06:00", "America/Los_Angeles").toISOString()).toBe("2026-12-01T14:00:00.000Z");
  });

  it("previousPeriod has equal length", () => {
    expect(previousPeriod("2026-11-01", "2026-11-28")).toEqual({ from: "2026-10-04", to: "2026-10-31" });
    expect(daysBetweenInclusive("2026-02-27", "2026-03-01")).toBe(3);
    expect(addDays("2024-02-28", 1)).toBe("2024-02-29");
  });

  it("resolveRange defaults to last 28 complete days and caps length", () => {
    const now = new Date("2026-11-23T12:00:00Z");
    expect(resolveRange({}, "UTC", now)).toEqual({ from: "2026-10-26", to: "2026-11-22" });
    const r = resolveRange({ from: "2020-01-01", to: "2026-11-22" }, "UTC", now);
    expect(daysBetweenInclusive(r.from, r.to)).toBe(400);
    expect(resolveRange({ from: "2026-11-10", to: "2026-11-01" }, "UTC", now)).toEqual({ from: "2026-11-01", to: "2026-11-10" });
  });
});

describe("scheduler", () => {
  it("next run is daily at local time + buffer + bounded jitter, strictly in the future", () => {
    const after = new Date("2026-11-23T10:00:00Z"); // 02:00 LA
    const next = computeNextRun({ after, localTime: "06:00", timezone: "America/Los_Angeles", bufferMinutes: 30, jitterSeed: "conn-1" });
    const j = jitterMinutes("conn-1");
    expect(j).toBeGreaterThanOrEqual(0);
    expect(j).toBeLessThanOrEqual(15);
    expect(next.toISOString()).toBe(new Date(Date.parse("2026-11-23T14:30:00Z") + j * 60_000).toISOString());
    const following = computeNextRun({ after: next, localTime: "06:00", timezone: "America/Los_Angeles", bufferMinutes: 30, jitterSeed: "conn-1" });
    expect(following.getTime() - next.getTime()).toBe(24 * 3600_000);
  });

  it("backoff grows exponentially with jitter and is capped", () => {
    expect(backoffSeconds(1, 30, 3600, () => 0)).toBe(15);
    expect(backoffSeconds(3, 30, 3600, () => 1)).toBe(120);
    expect(backoffSeconds(20, 30, 3600, () => 1)).toBe(3600);
  });
});

describe("sync window and cursor progression", () => {
  const now = new Date("2026-11-23T12:00:00Z");
  it("first sync backfills N days ending yesterday", () => {
    expect(computeSyncWindow({ now, timezone: "UTC", cursorDate: null, lookbackDays: 3, initialBackfillDays: 30 })).toEqual({
      from: "2026-10-24",
      to: "2026-11-22",
    });
  });
  it("incremental sync re-fetches the lookback window for late-arriving data", () => {
    expect(computeSyncWindow({ now, timezone: "UTC", cursorDate: "2026-11-22", lookbackDays: 3, initialBackfillDays: 30 })).toEqual({
      from: "2026-11-20",
      to: "2026-11-22",
    });
  });
  it("after a gap it resumes from the cursor", () => {
    expect(computeSyncWindow({ now, timezone: "UTC", cursorDate: "2026-11-10", lookbackDays: 3, initialBackfillDays: 30 })).toEqual({
      from: "2026-11-11",
      to: "2026-11-22",
    });
  });
  it("uses the company timezone for 'yesterday'", () => {
    const lateEvening = new Date("2026-11-23T06:00:00Z"); // 22:00 on the 22nd in LA
    expect(computeSyncWindow({ now: lateEvening, timezone: "America/Los_Angeles", cursorDate: "2026-11-21", lookbackDays: 1, initialBackfillDays: 30 })).toEqual({
      from: "2026-11-21",
      to: "2026-11-21",
    });
  });
});

describe("normalization", () => {
  it("preliminary vs final depends on finalization window", () => {
    expect(dataStatusFor("2026-11-22", "2026-11-23", 3)).toBe("preliminary");
    expect(dataStatusFor("2026-11-20", "2026-11-23", 3)).toBe("preliminary");
    expect(dataStatusFor("2026-11-19", "2026-11-23", 3)).toBe("final");
    expect(dataStatusFor("2026-11-22", "2026-11-23", 0)).toBe("final");
  });

  it("row keys are deterministic per grain (dedup across re-syncs)", () => {
    const a = rowKey({ metric_date: "2026-11-01", origin: "csv", source: "meta", account_id: "x", campaign_id: "1" });
    const b = rowKey({ metric_date: "2026-11-01", origin: "csv", source: "meta", account_id: "x", campaign_id: "1" });
    const c = rowKey({ metric_date: "2026-11-01", origin: "ga4", source: "meta", account_id: "x", campaign_id: "1" });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it("aggregates provider rows that share a grain and keeps currency/timezone", () => {
    const rec = {
      date: "2026-11-01",
      account_id: "1",
      account_name: null,
      campaign_id: "(not set)",
      campaign_name: null,
      currency: "EUR",
      timezone: "Europe/Berlin",
      metrics: { impressions: null, clicks: null, spend: null, sessions: 5, conversions: 1, conversion_type: "ga4_key_event" as const, leads: null, attributed_revenue: null, billed_revenue: null },
      raw: {},
    };
    const out = normalizeProviderRecords([rec, rec], {
      syncRunId: "r",
      origin: "ga4",
      isSimulated: false,
      today: "2026-11-23",
      finalizationDays: 3,
      now: new Date(),
    });
    expect(out.normalized).toHaveLength(1);
    expect(out.normalized[0]).toMatchObject({ sessions: 10, conversions: 2, attributed_revenue: null, currency: "EUR", source_timezone: "Europe/Berlin", data_status: "final" });
    expect(out.raw).toHaveLength(2);
  });
});
