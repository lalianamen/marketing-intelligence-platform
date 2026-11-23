import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AccessDeniedError, getCompanyAccess } from "@/server/auth/authz";
import { getDashboardData } from "@/server/metrics/dashboard";
import { storeValidatedUpload } from "@/server/ingestion/uploads";
import { anonClient, createCompany, createVerifiedUser, pool, type TestUser, workerDeps } from "./helpers";

let A: TestUser;
let B: TestUser;
let a1: string;
let a2: string;
let b1: string;
let aUpload: string;
let aCsvConn: string;

beforeAll(async () => {
  A = await createVerifiedUser("tenantA");
  B = await createVerifiedUser("tenantB");
  a1 = await createCompany(A, "A One");
  a2 = await createCompany(A, "A Two");
  b1 = await createCompany(B, "B One");
  const up = await storeValidatedUpload(pool, {
    userId: A.id,
    companyId: a1,
    filename: "a.csv",
    text: "date,source,campaign_name,clicks\n2026-11-01,x,y,5\n",
    byteSize: 50,
  });
  aUpload = up.uploadId!;
  aCsvConn = (await A.client.rpc("ensure_csv_connection", { p_company_id: a1 })).data as string;
});

afterAll(async () => {
  await pool.end();
});

describe("multiple companies in one workspace", () => {
  it("owner sees both of their companies, each with its own provisioning job", async () => {
    const r = await A.client.from("companies").select("id,name").order("name");
    expect(r.data!.map((c) => c.id)).toEqual([a1, a2]);
    const jobs = await A.client.from("provisioning_jobs").select("company_id,status");
    expect(new Set(jobs.data!.map((j) => j.company_id))).toEqual(new Set([a1, a2]));
  });
});

describe("cross-tenant RLS denial", () => {
  it("B cannot read A's workspace, companies, jobs, connections, uploads or audit logs", async () => {
    for (const table of ["workspaces", "companies", "provisioning_jobs", "company_connections", "csv_uploads", "audit_logs", "analytics_resources", "sync_runs", "company_settings", "workspace_members"]) {
      const col = table === "workspaces" ? "id" : table === "company_settings" ? "company_id" : table === "workspace_members" ? "workspace_id" : "workspace_id";
      const r = await B.client.from(table).select(col).eq(col, table === "company_settings" ? a1 : A.workspaceId);
      expect(r.data ?? [], table).toEqual([]);
    }
    expect((await B.client.from("companies").select("id").eq("id", a1)).data).toEqual([]);
  });

  it("forged IDs in RPCs are rejected with the same 'not found' error (no enumeration)", async () => {
    const forged = await B.client.rpc("create_company", { p_workspace_id: A.workspaceId, p_name: "Injected" });
    expect(forged.error?.message).toMatch(/workspace not found/);
    const random = await B.client.rpc("create_company", { p_workspace_id: "00000000-0000-0000-0000-000000000000", p_name: "x" });
    expect(random.error?.message).toMatch(/workspace not found/);
    expect((await B.client.rpc("ensure_csv_connection", { p_company_id: a1 })).error?.message).toMatch(/not found/);
    expect((await B.client.rpc("retry_provisioning", { p_company_id: a1 })).error?.message).toMatch(/not found/);
    expect((await B.client.rpc("queue_csv_import", { p_upload_id: aUpload })).error?.message).toMatch(/not found/);
    expect((await B.client.rpc("request_sync", { p_connection_id: aCsvConn })).error?.message).toMatch(/not found/);
    expect((await B.client.rpc("disconnect_connection", { p_connection_id: aCsvConn })).error?.message).toMatch(/not found/);
    expect((await B.client.rpc("enable_simulated_connection", { p_company_id: a1, p_provider_id: "ga4" })).error?.message).toMatch(/not found/);
    const n = await pool.query(`select count(*)::int as n from public.companies where name = 'Injected'`);
    expect(n.rows[0].n).toBe(0);
  });

  it("direct table writes are blocked: no inserts, no tenant moves, no role escalation", async () => {
    const ins = await B.client.from("companies").insert({ workspace_id: A.workspaceId, name: "x", created_by: B.id });
    expect(ins.error).not.toBeNull();
    const move = await A.client.from("companies").update({ workspace_id: B.workspaceId }).eq("id", a1);
    expect(move.error).not.toBeNull();
    const esc = await B.client.from("workspace_members").update({ role: "owner" }).eq("user_id", B.id);
    expect(esc.error).not.toBeNull();
    const join = await B.client.from("workspace_members").insert({ workspace_id: A.workspaceId, user_id: B.id, role: "owner" });
    expect(join.error).not.toBeNull();
    const res = await B.client.from("analytics_resources").insert({
      workspace_id: B.workspaceId, company_id: b1, provider: "local", cloud_project_id: "00000000-0000-0000-0000-000000000000",
      project_id: "local", dataset_id: "x", location: "local", is_simulated: true,
    });
    expect(res.error).not.toBeNull();
    const ok = await A.client.from("companies").update({ name: "A One renamed" }).eq("id", a1).select("name");
    expect(ok.data).toEqual([{ name: "A One renamed" }]);
    const foreign = await B.client.from("companies").update({ name: "hijack" }).eq("id", a1).select("id");
    expect(foreign.data ?? []).toEqual([]);
  });

  it("server-only tables and columns are unreachable from the API", async () => {
    expect((await A.client.from("connection_secrets").select("*")).error).not.toBeNull();
    expect((await A.client.from("oauth_states").select("*")).error).not.toBeNull();
    expect((await A.client.from("cloud_projects").select("*")).error).not.toBeNull();
    expect((await A.client.from("csv_uploads").select("rows")).error).not.toBeNull();
    expect((await A.client.from("csv_uploads").select("id,row_count")).data).toHaveLength(1);
  });

  it("anonymous requests see nothing and cannot call RPCs", async () => {
    const anon = anonClient();
    expect((await anon.from("companies").select("id")).data ?? []).toEqual([]);
    expect((await anon.from("connector_providers").select("id")).data ?? []).toEqual([]);
    expect((await anon.rpc("create_company", { p_workspace_id: A.workspaceId, p_name: "x" })).error).not.toBeNull();
  });

  it("company_viewer can read one company only and cannot manage it", async () => {
    await pool.query(`insert into public.company_members (company_id, workspace_id, user_id, role) values ($1, $2, $3, 'company_viewer')`, [a1, A.workspaceId, B.id]);
    const seen = await B.client.from("companies").select("id").in("id", [a1, a2]);
    expect(seen.data!.map((x) => x.id)).toEqual([a1]);
    expect((await B.client.rpc("ensure_csv_connection", { p_company_id: a1 })).error).not.toBeNull();
    expect((await B.client.from("workspaces").select("id").eq("id", A.workspaceId)).data).toEqual([]);
    expect(await getCompanyAccess(pool, B.id, a1)).toBe("read");
    await expect(storeValidatedUpload(pool, { userId: B.id, companyId: a1, filename: "x.csv", text: "x", byteSize: 1 })).rejects.toBeInstanceOf(AccessDeniedError);
    await pool.query(`delete from public.company_members where company_id = $1 and user_id = $2`, [a1, B.id]);
  });

  it("server-side authorization denies forged company IDs independently of RLS", async () => {
    expect(await getCompanyAccess(pool, B.id, a1)).toBeNull();
    expect(await getCompanyAccess(pool, B.id, "not-a-uuid")).toBeNull();
    expect(await getCompanyAccess(pool, A.id, a1)).toBe("manage");
    const deps = await workerDeps();
    await expect(getDashboardData(pool, deps.getWarehouse, B.id, a1, { from: "2026-11-01", to: "2026-11-02" })).rejects.toBeInstanceOf(AccessDeniedError);
    await expect(storeValidatedUpload(pool, { userId: B.id, companyId: a1, filename: "x.csv", text: "x", byteSize: 1 })).rejects.toBeInstanceOf(AccessDeniedError);
  });

  it("company creation is rate limited and capped per workspace", async () => {
    await pool.query(`update public.workspaces set max_companies = 3 where id = $1`, [B.workspaceId]);
    await createCompany(B, "B Two");
    await createCompany(B, "B Three");
    const over = await B.client.rpc("create_company", { p_workspace_id: B.workspaceId, p_name: "B Four" });
    expect(over.error?.message).toMatch(/company limit reached/);
    await pool.query(`update public.workspaces set max_companies = 1000 where id = $1`, [B.workspaceId]);
    let limited = false;
    for (let i = 0; i < 25 && !limited; i++) {
      const r = await B.client.rpc("create_company", { p_workspace_id: B.workspaceId, p_name: `bulk ${i}` });
      if (r.error?.message.match(/rate limit/)) limited = true;
    }
    expect(limited).toBe(true);
  });

  it("invalid timezone is rejected", async () => {
    const r = await A.client.rpc("create_company", { p_workspace_id: A.workspaceId, p_name: "TZ", p_timezone: "Mars/Olympus" });
    expect(r.error?.message).toMatch(/invalid timezone/);
  });
});
