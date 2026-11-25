import { describe, expect, it, vi } from "vitest";
import { listAdsCustomers, listGa4Properties } from "@/server/connectors/google";

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

describe("account discovery after Google consent", () => {
  it("lists GA4 properties across accounts and pages", async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(ok({
        accountSummaries: [{ displayName: "LICENA LLC", propertySummaries: [{ property: "properties/111", displayName: "licena.us" }] }],
        nextPageToken: "p2",
      }))
      .mockResolvedValueOnce(ok({ accountSummaries: [{ displayName: "Other", propertySummaries: [{ property: "properties/222", displayName: "Blog" }, { property: "bad", displayName: "x" }] }] }));
    const r = await listGa4Properties("tok", f);
    expect(r).toEqual([
      { id: "111", name: "licena.us", group: "LICENA LLC" },
      { id: "222", name: "Blog", group: "Other" },
    ]);
    expect(String(f.mock.calls[1]![0])).toContain("pageToken=p2");
    expect((f.mock.calls[0]![1] as RequestInit).headers).toEqual({ authorization: "Bearer tok" });
  });

  it("reports a disabled Admin API as not_configured", async () => {
    const f = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { status: "PERMISSION_DENIED", details: [{ reason: "SERVICE_DISABLED" }] } }), { status: 403 }));
    await expect(listGa4Properties("tok", f)).rejects.toMatchObject({ code: "not_configured" });
  });

  it("lists Google Ads customers with names and skips manager accounts", async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(ok({ resourceNames: ["customers/1234567890", "customers/9999999999", "nope"] }))
      .mockResolvedValueOnce(ok({ results: [{ customer: { descriptiveName: "LICENA Ads", manager: false } }] }))
      .mockResolvedValueOnce(ok({ results: [{ customer: { descriptiveName: "My MCC", manager: true } }] }));
    const r = await listAdsCustomers("tok", { apiVersion: "v26", developerToken: "dev", fetch: f });
    expect(r).toEqual([{ id: "1234567890", name: "LICENA Ads", group: null }]);
    expect(String(f.mock.calls[0]![0])).toBe("https://googleads.googleapis.com/v26/customers:listAccessibleCustomers");
    expect((f.mock.calls[0]![1] as { headers: Record<string, string> }).headers["developer-token"]).toBe("dev");
  });

  it("keeps an Ads account selectable when its name cannot be read", async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(ok({ resourceNames: ["customers/1234567890"] }))
      .mockResolvedValue(new Response("denied", { status: 403 }));
    const r = await listAdsCustomers("tok", { apiVersion: "v26", fetch: f });
    expect(r).toEqual([{ id: "1234567890", name: "Google Ads 123-456-7890", group: null }]);
  });
});
