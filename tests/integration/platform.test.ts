import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runPendingWork } from "@/server/jobs/runner";
import { closePool } from "@/server/db";
import { ensureLocalWarehouseDatabase } from "@/server/warehouse/local";
import { cfg, createVerifiedUser, onlyCompanies, pool, type TestUser } from "./helpers";

let U: TestUser;
beforeAll(async () => {
  U = await createVerifiedUser("platform");
});
afterAll(async () => {
  await pool.end();
  await closePool();
});

describe("business type", () => {
  it("is stored on create, defaults to other, validated, and editable by the owner", async () => {
    const r = await U.client.rpc("create_company", { p_workspace_id: U.workspaceId, p_name: "HVAC Co", p_timezone: "America/Los_Angeles", p_business_type: "local_service" });
    expect(r.error).toBeNull();
    const d = await U.client.rpc("create_company", { p_workspace_id: U.workspaceId, p_name: "Default Co" });
    const rows = await U.client.from("companies").select("id,business_type").in("id", [r.data, d.data]);
    expect(Object.fromEntries(rows.data!.map((x) => [x.id, x.business_type]))).toEqual({ [r.data]: "local_service", [d.data]: "other" });
    const bad = await U.client.rpc("create_company", { p_workspace_id: U.workspaceId, p_name: "Bad", p_business_type: "casino" });
    expect(bad.error?.message).toMatch(/invalid business type/);
    const upd = await U.client.from("companies").update({ business_type: "ecommerce" }).eq("id", d.data).select("business_type");
    expect(upd.data).toEqual([{ business_type: "ecommerce" }]);
    const providers = await U.client.from("connector_providers").select("id,relevant_for").eq("id", "field_service_crm");
    expect(providers.data![0]!.relevant_for).toContain("local_service");
  });
});

describe("serverless job runner (used by Vercel cron and after())", () => {
  it("provisions a new company's data space within a time budget, without a separate worker", async () => {
    const r = await U.client.rpc("create_company", { p_workspace_id: U.workspaceId, p_name: "Inline Co", p_business_type: "ecommerce" });
    await onlyCompanies([r.data as string]);
    const summary = await runPendingWork({ budgetMs: 20_000, maintenance: true });
    expect(summary.provisioning).toBeGreaterThanOrEqual(1);
    const res = await pool.query(`select status from public.analytics_resources where company_id = $1`, [r.data]);
    expect(res.rows[0]?.status).toBe("ready");
    const again = await runPendingWork({ budgetMs: 5_000 });
    expect(again).toMatchObject({ provisioning: 0, syncs: 0, stoppedBy: "idle" });
  });

  it("the simulated warehouse can live inside the main database (hosted Supabase)", async () => {
    await expect(ensureLocalWarehouseDatabase(cfg.databaseUrl, cfg.databaseUrl)).resolves.toBeUndefined();
  });
});
