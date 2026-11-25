import { describe, expect, it, vi } from "vitest";
import { Ga4Connector, ga4Date } from "@/server/connectors/ga4";
import { buildGaql, GoogleAdsConnector } from "@/server/connectors/googleAds";
import { postJson } from "@/server/connectors/google";
import { SimulatedConnector } from "@/server/connectors/simulated";
import { ConnectorError } from "@/server/connectors/types";
import { BigQueryWarehouse, mapBigQueryError } from "@/server/warehouse/bigquery";
import type { DatasetRef } from "@/server/warehouse/types";

const json = (status: number, body: unknown) =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const tokenOk = json(200, { access_token: "ya29.test" });
const ctx = {
  window: { from: "2026-11-01", to: "2026-11-02" },
  companyId: "c",
  companyTimezone: "UTC",
  credentials: { refreshToken: "1//rt" },
  now: new Date("2026-11-23T12:00:00Z"),
};

describe("GA4 connector (mocked HTTP)", () => {
  it("maps runReport rows to daily records with GA4 key events and property currency/timezone", async () => {
    const f = vi.fn().mockResolvedValueOnce(tokenOk.clone()).mockResolvedValueOnce(
      json(200, {
        rowCount: 1,
        metadata: { currencyCode: "EUR", timeZone: "Europe/Berlin" },
        rows: [{ dimensionValues: [{ value: "20261101" }, { value: "42" }, { value: "Spring" }], metricValues: [{ value: "120" }, { value: "7" }, { value: "350.5" }] }],
      }),
    );
    const c = new Ga4Connector({ clientId: "id", clientSecret: "s", fetch: f });
    const out = await c.fetchDaily({ ...ctx, externalAccountId: "123456" });
    expect(out.complete).toBe(true);
    expect(out.records[0]).toMatchObject({
      date: "2026-11-01",
      campaign_id: "42",
      currency: "EUR",
      timezone: "Europe/Berlin",
      metrics: { sessions: 120, conversions: 7, conversion_type: "ga4_key_event", attributed_revenue: 350.5, spend: null, clicks: null },
    });
    const body = JSON.parse((f.mock.calls[1]![1] as RequestInit).body as string);
    expect(body.metrics.map((m: { name: string }) => m.name)).toEqual(["sessions", "keyEvents", "totalRevenue"]);
    expect(String(f.mock.calls[1]![0])).toContain("/v1beta/properties/123456:runReport");
  });

  it("traffic without a campaign keeps one row per channel instead of merging under \"(not set)\"", async () => {
    const row = (name: string, sessions: string) => ({ dimensionValues: [{ value: "20261101" }, { value: "(not set)" }, { value: name }], metricValues: [{ value: sessions }, { value: "0" }, { value: "0" }] });
    const f = vi.fn().mockResolvedValueOnce(tokenOk.clone()).mockResolvedValueOnce(json(200, { rowCount: 2, metadata: {}, rows: [row("(organic)", "18"), row("(direct)", "20")] }));
    const c = new Ga4Connector({ clientId: "id", clientSecret: "s", fetch: f });
    const out = await c.fetchDaily({ ...ctx, externalAccountId: "123456" });
    expect(out.records.map((r) => [r.campaign_id, r.campaign_name, r.metrics.sessions])).toEqual([
      ["(not set) (organic)", "(organic)", 18],
      ["(not set) (direct)", "(direct)", 20],
    ]);
  });

  it("one request with the base fields plus every chosen group; rows of a campaign stay apart in raw, sum for the dashboard", async () => {
    const row = (campaign: string, source: string, sessions: string) => ({
      dimensionValues: ["20261101", "(not set)", campaign, source, "organic", "Organic Search"].map((value) => ({ value })),
      metricValues: [sessions, "1", "0"].map((value) => ({ value })),
    });
    const f = vi.fn().mockResolvedValueOnce(tokenOk.clone()).mockResolvedValueOnce(json(200, { rowCount: 2, metadata: {}, rows: [row("(organic)", "google", "17"), row("(organic)", "bing", "1")] }));
    const c = new Ga4Connector({ clientId: "id", clientSecret: "s", fetch: f });
    const out = await c.fetchDaily({ ...ctx, externalAccountId: "123456", options: { ga4Reports: ["traffic_sources", "bogus"] } });
    const body = JSON.parse((f.mock.calls[1]![1] as RequestInit).body as string);
    expect(body.dimensions.map((d: { name: string }) => d.name)).toEqual(["date", "sessionCampaignId", "sessionCampaignName", "sessionSource", "sessionMedium", "sessionDefaultChannelGroup"]);
    expect(body.metrics.map((m: { name: string }) => m.name)).toEqual(["sessions", "keyEvents", "totalRevenue"]);
    expect(out.records.map((r) => r.raw)).toEqual([
      expect.objectContaining({ sessionCampaignName: "(organic)", sessionSource: "google", sessions: "17" }),
      expect.objectContaining({ sessionCampaignName: "(organic)", sessionSource: "bing", sessions: "1" }),
    ]);
    expect(new Set(out.records.map((r) => r.rawKey)).size).toBe(2);
    expect(new Set(out.records.map((r) => r.campaign_id))).toEqual(new Set(["(not set) (organic)"]));
  });

  it("expired refresh token → auth_expired (not retryable)", async () => {
    const f = vi.fn().mockResolvedValue(json(400, { error: "invalid_grant" }));
    const c = new Ga4Connector({ clientId: "id", clientSecret: "s", fetch: f });
    const err = await c.fetchDaily({ ...ctx, externalAccountId: "1" }).catch((e) => e);
    expect(err).toBeInstanceOf(ConnectorError);
    expect(err.code).toBe("auth_expired");
    expect(err.retryable).toBe(false);
  });

  it("rejects non-numeric property ids (no injection into URL)", async () => {
    const c = new Ga4Connector({ clientId: "id", clientSecret: "s", fetch: vi.fn() });
    await expect(c.fetchDaily({ ...ctx, externalAccountId: "1/../x" })).rejects.toMatchObject({ code: "invalid_request" });
  });

  it("parses GA4 dates strictly", () => {
    expect(ga4Date("20261101")).toBe("2026-11-01");
    expect(() => ga4Date("2026-11-01")).toThrow();
  });
});

describe("Google Ads connector (mocked HTTP)", () => {
  it("builds GAQL with validated dates", () => {
    expect(buildGaql("2026-11-01", "2026-11-02")).toContain("segments.date BETWEEN '2026-11-01' AND '2026-11-02'");
    expect(() => buildGaql("2026-11-01' OR 1=1 --", "2026-11-02")).toThrow();
  });

  it("maps searchStream results, converts micros, sends login-customer-id", async () => {
    const f = vi.fn().mockResolvedValueOnce(tokenOk.clone()).mockResolvedValueOnce(
      json(200, [
        {
          results: [
            {
              segments: { date: "2026-11-01" },
              customer: { id: "1234567890", descriptiveName: "Acme", currencyCode: "USD", timeZone: "America/Los_Angeles" },
              campaign: { id: "555", name: "Brand" },
              metrics: { impressions: "1000", clicks: "50", costMicros: "12340000", conversions: 3.5, conversionsValue: 210 },
            },
            { segments: { date: "2026-11-02" }, campaign: { id: "555", name: "Brand" }, metrics: {} },
          ],
        },
      ]),
    );
    const c = new GoogleAdsConnector({ clientId: "id", clientSecret: "s", apiVersion: "v26", loginCustomerId: "111-222-3333", fetch: f });
    const out = await c.fetchDaily({ ...ctx, externalAccountId: "123-456-7890" });
    expect(out.records[0]!.metrics).toMatchObject({ impressions: 1000, clicks: 50, spend: 12.34, conversions: 3.5, conversion_type: "ad_platform_conversion", attributed_revenue: 210 });
    expect(out.records[0]!.timezone).toBe("America/Los_Angeles");
    expect(out.records[1]!.metrics.spend).toBe(0); // omitted proto3 field = 0
    const headers = (f.mock.calls[1]![1] as RequestInit).headers as Record<string, string>;
    expect(headers["login-customer-id"]).toBe("1112223333");
    expect(String(f.mock.calls[1]![0])).toBe("https://googleads.googleapis.com/v26/customers/1234567890/googleAds:searchStream");
  });

  it("permission denied without account access is surfaced, not hidden", async () => {
    const f = vi.fn().mockResolvedValueOnce(tokenOk.clone()).mockResolvedValueOnce(json(403, { error: { status: "PERMISSION_DENIED", message: "USER_PERMISSION_DENIED" } }));
    const c = new GoogleAdsConnector({ clientId: "id", clientSecret: "s", apiVersion: "v26", fetch: f });
    await expect(c.fetchDaily({ ...ctx, externalAccountId: "1234567890" })).rejects.toMatchObject({ code: "permission_denied" });
  });
});

describe("postJson retry behaviour", () => {
  it("retries 429/5xx with backoff and succeeds", async () => {
    const f = vi.fn().mockResolvedValueOnce(json(429, "slow down")).mockResolvedValueOnce(json(503, "x")).mockResolvedValueOnce(json(200, { ok: 1 }));
    const sleep = vi.fn().mockResolvedValue(undefined);
    const r = await postJson(f, "https://x", {}, {}, "t", { sleep, baseDelayMs: 10 });
    expect(r.calls).toBe(3);
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([10, 20]);
  });
  it("does not hammer on daily quota exhaustion", async () => {
    const f = vi.fn().mockResolvedValue(json(403, { error: { status: "RESOURCE_EXHAUSTED" } }));
    await expect(postJson(f, "https://x", {}, {}, "t", { sleep: async () => undefined })).rejects.toMatchObject({ code: "quota_exceeded", retryable: true });
    expect(f).toHaveBeenCalledTimes(1);
  });
});

describe("Simulated connector", () => {
  it("is deterministic, complete-days-only, and models late arrivals", async () => {
    const c = new SimulatedConnector("google_ads");
    const a = await c.fetchDaily({ ...ctx, externalAccountId: "x", window: { from: "2026-11-20", to: "2026-11-23" } });
    const b = await c.fetchDaily({ ...ctx, externalAccountId: "x", window: { from: "2026-11-20", to: "2026-11-23" } });
    expect(a.records).toEqual(b.records);
    expect(a.records.every((r) => r.date < "2026-11-23")).toBe(true);
    const later = await c.fetchDaily({ ...ctx, now: new Date("2026-12-20T12:00:00Z"), externalAccountId: "x", window: { from: "2026-11-22", to: "2026-11-22" } });
    const early = a.records.filter((r) => r.date === "2026-11-22").reduce((s, r) => s + (r.metrics.conversions ?? 0), 0);
    const mature = later.records.reduce((s, r) => s + (r.metrics.conversions ?? 0), 0);
    expect(mature).toBeGreaterThan(early);
  });
});

describe("BigQuery adapter (mocked SDK)", () => {
  const ref: DatasetRef = { provider: "bigquery", projectId: "mip-dev-project", datasetId: "mip_dev_c_abc", location: "US" };

  function mockClient() {
    const create = vi.fn().mockResolvedValue([{}]);
    const getMetadata = vi.fn().mockResolvedValue([{ location: "US", labels: { mip_company: "c1", mip_workspace: "w1", mip_env: "mip_dev" } }]);
    const job = { getQueryResults: vi.fn().mockResolvedValue([[{ d: "2026-11-01" }]]), metadata: { statistics: { totalBytesProcessed: "1048576", query: { totalBytesBilled: "10485760" } } } };
    const client = {
      dataset: vi.fn().mockReturnValue({ create, getMetadata }),
      createQueryJob: vi.fn().mockResolvedValue([job]),
    };
    return { client, create, getMetadata, job };
  }

  it("duplicate check: nothing to do when every key is unique; otherwise one MERGE keeps the newest copy", async () => {
    const { client, job } = mockClient();
    const wh = new BigQueryWarehouse(client as never, { maxBytesBilled: 1000, billingApproved: true });
    job.getQueryResults.mockResolvedValue([[]]);
    expect(await wh.removeDuplicates(ref, { from: "2026-11-01", to: "2026-11-03" })).toEqual({ raw: 0, normalized: 0 });
    expect(client.createQueryJob).toHaveBeenCalledTimes(2); // two reads, no writes

    client.createQueryJob.mockClear();
    job.getQueryResults
      .mockResolvedValueOnce([[{ k: '{"record_id":"a"}', n: 3 }]]) // raw: one id stored 3 times
      .mockResolvedValueOnce([[]]) // the MERGE
      .mockResolvedValueOnce([[]]); // normalized: clean
    expect(await wh.removeDuplicates(ref, { from: "2026-11-01", to: "2026-11-03" })).toEqual({ raw: 2, normalized: 0 });
    const merge = client.createQueryJob.mock.calls[1]![0];
    expect(merge.query).toMatch(/MERGE .*raw_records.* T/s);
    expect(merge.query).toMatch(/ON FALSE/);
    expect(merge.query).toMatch(/ROW_NUMBER\(\) OVER \(PARTITION BY record_id ORDER BY ingested_at DESC\) = 1/);
    expect(merge.params.keys).toEqual(['{"record_id":"a"}']);
  });

  it("refuses to create datasets until billing is explicitly approved", async () => {
    const { client, create } = mockClient();
    const wh = new BigQueryWarehouse(client as never, { maxBytesBilled: 1000, billingApproved: false });
    await expect(wh.ensureDataset(ref, { mip_company: "c1", mip_workspace: "w1", mip_env: "mip_dev" })).rejects.toMatchObject({ code: "permission_denied" });
    expect(create).not.toHaveBeenCalled();
  });

  it("creates dataset with location + labels; 409 means 'exists' (idempotent retry)", async () => {
    const { client, create } = mockClient();
    const wh = new BigQueryWarehouse(client as never, { maxBytesBilled: 1000, billingApproved: true });
    const labels = { mip_company: "c1", mip_workspace: "w1", mip_env: "mip_dev" };
    expect(await wh.ensureDataset(ref, labels)).toBe("created");
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ location: "US", labels }));
    create.mockRejectedValueOnce(Object.assign(new Error("Already Exists: Dataset"), { code: 409, errors: [{ reason: "duplicate" }] }));
    expect(await wh.ensureDataset(ref, labels)).toBe("exists");
  });

  it("every query sets maximumBytesBilled, location and named parameters; stats are reported", async () => {
    const { client } = mockClient();
    const wh = new BigQueryWarehouse(client as never, { maxBytesBilled: 104857600, billingApproved: true });
    const dates = await wh.coveredDates(ref, "csv", { from: "2026-11-01", to: "2026-11-30" });
    expect(dates).toEqual(["2026-11-01"]);
    const opts = client.createQueryJob.mock.calls[0]![0];
    expect(opts).toMatchObject({ maximumBytesBilled: "104857600", location: "US", useLegacySql: false, params: { origin: "csv", from: { value: "2026-11-01" } } });
    expect(opts.query).toContain("`mip-dev-project.mip_dev_c_abc.norm_campaign_daily`");
    expect(opts.query).toContain("metric_date BETWEEN @from AND @to");
    const daily = await wh.queryDaily(ref, { from: "2026-11-01", to: "2026-11-02" });
    expect(daily.stats).toEqual({ bytesProcessed: 1048576, bytesBilled: 10485760 });
  });

  it("schema DDL is partitioned by date and clustered", async () => {
    const { client } = mockClient();
    const wh = new BigQueryWarehouse(client as never, { maxBytesBilled: 1, billingApproved: true });
    await wh.ensureSchema(ref, 1);
    const ddl = client.createQueryJob.mock.calls.map((c) => c[0].query as string).join("\n");
    expect(ddl).toMatch(/norm_campaign_daily[\s\S]*PARTITION BY metric_date CLUSTER BY origin, source, campaign_id/);
    expect(ddl).toMatch(/mart_daily_source[\s\S]*PARTITION BY metric_date/);
  });

  it("rejects refs that are not BigQuery or have unsafe identifiers", async () => {
    const { client } = mockClient();
    const wh = new BigQueryWarehouse(client as never, { maxBytesBilled: 1, billingApproved: true });
    await expect(wh.queryDaily({ ...ref, datasetId: "x`; DROP" }, { from: "2026-11-01", to: "2026-11-01" })).rejects.toThrow();
    await expect(wh.queryDaily({ ...ref, provider: "local" }, { from: "2026-11-01", to: "2026-11-01" })).rejects.toThrow();
  });

  it("maps Google API errors to retryable / non-retryable codes", () => {
    expect(mapBigQueryError({ code: 403, errors: [{ reason: "quotaExceeded" }] })).toMatchObject({ code: "quota_exceeded", retryable: true });
    expect(mapBigQueryError({ code: 403, errors: [{ reason: "rateLimitExceeded" }] })).toMatchObject({ code: "rate_limited", retryable: true });
    expect(mapBigQueryError({ code: "ETIMEDOUT", message: "x" })).toMatchObject({ code: "timeout", retryable: true });
    expect(mapBigQueryError({ code: 503, message: "x" })).toMatchObject({ code: "unavailable", retryable: true });
    expect(mapBigQueryError({ code: 403, errors: [{ reason: "accessDenied" }] })).toMatchObject({ code: "permission_denied", retryable: false });
    expect(mapBigQueryError({ code: 400, errors: [{ reason: "bytesBilledLimitExceeded" }] })).toMatchObject({ code: "bytes_limit_exceeded", retryable: false });
  });
});

describe("BigQuery typed parameters", () => {
  it("DATE and TIMESTAMP strings reach BigQuery as values, not NULL (top level, arrays of structs)", async () => {
    const { BigQuery } = await import("@google-cloud/bigquery");
    const { wrapTypedParams } = await import("@/server/warehouse/bigquery");
    const toParam = (BigQuery as unknown as { valueToQueryParameter_: (v: unknown, t: unknown) => { parameterValue: Record<string, unknown> } }).valueToQueryParameter_;
    const types = { rows: [{ record_date: "DATE", ingested_at: "TIMESTAMP", origin: "STRING" }], d: "DATE" };
    const params = { rows: [{ record_date: "2026-11-20", ingested_at: "2026-11-25T03:37:00.000Z", origin: "ga4" }], d: "2026-11-01" };
    // Unwrapped strings are what broke production: the client sends them as null.
    expect(toParam(params.d, "DATE").parameterValue.value).toBeUndefined();
    const w = wrapTypedParams(params, types) as typeof params;
    expect(toParam(w.d, "DATE").parameterValue.value).toBe("2026-11-01");
    const arr = toParam(w.rows, types.rows).parameterValue.arrayValues as { structValues: Record<string, { value: unknown }> }[];
    expect(arr[0]!.structValues.record_date!.value).toBe("2026-11-20");
    expect(arr[0]!.structValues.ingested_at!.value).toBe("2026-11-25T03:37:00.000Z");
    expect(arr[0]!.structValues.origin!.value).toBe("ga4");
    expect(wrapTypedParams({ x: null }, { x: "DATE" })).toEqual({ x: null });
  });
});
