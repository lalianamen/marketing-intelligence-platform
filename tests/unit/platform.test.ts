import { describe, expect, it } from "vitest";
import { BUSINESS_PROFILES, BUSINESS_TYPES, profileFor } from "@/lib/businessTypes";
import { workloadIdentityConfig } from "@/server/warehouse";

describe("business types", () => {
  it("every type has a complete profile and falls back to 'other'", () => {
    for (const t of BUSINESS_TYPES) {
      const p = BUSINESS_PROFILES[t];
      expect(p.label.length).toBeGreaterThan(0);
      expect(p.recommendedSources).toContain("csv");
      expect(p.headline.length).toBeGreaterThan(0);
    }
    expect(profileFor("nonsense")).toBe(BUSINESS_PROFILES.other);
    expect(profileFor(null)).toBe(BUSINESS_PROFILES.other);
    expect(profileFor("local_service").recommendedSources[0]).toBe("google_ads");
  });
});

describe("keyless Google auth from Vercel (Workload Identity Federation)", () => {
  it("is off unless both variables are set", () => {
    expect(workloadIdentityConfig({})).toBeNull();
    expect(workloadIdentityConfig({ GCP_SERVICE_ACCOUNT_EMAIL: "mip-worker@mip-prod.iam.gserviceaccount.com" })).toBeNull();
  });
  it("builds an external_account config that impersonates the service account", () => {
    const c = workloadIdentityConfig({
      GCP_WORKLOAD_IDENTITY_PROVIDER: "projects/123456789/locations/global/workloadIdentityPools/vercel/providers/vercel",
      GCP_SERVICE_ACCOUNT_EMAIL: "mip-worker@mip-prod.iam.gserviceaccount.com",
    })!;
    expect(c.audience).toBe("//iam.googleapis.com/projects/123456789/locations/global/workloadIdentityPools/vercel/providers/vercel");
    expect(c.token_url).toBe("https://sts.googleapis.com/v1/token");
    expect(c.service_account_impersonation_url).toContain("mip-worker@mip-prod.iam.gserviceaccount.com:generateAccessToken");
  });
  it("rejects malformed values", () => {
    expect(() => workloadIdentityConfig({ GCP_WORKLOAD_IDENTITY_PROVIDER: "x", GCP_SERVICE_ACCOUNT_EMAIL: "a@b.iam.gserviceaccount.com" })).toThrow();
    expect(() =>
      workloadIdentityConfig({ GCP_WORKLOAD_IDENTITY_PROVIDER: "projects/1/locations/global/workloadIdentityPools/p/providers/v", GCP_SERVICE_ACCOUNT_EMAIL: "evil@example.com" }),
    ).toThrow();
  });
});
