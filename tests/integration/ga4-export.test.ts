import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { linkGa4Export, removeGa4Export } from "@/server/ga4export/link";
import { loadConnection, setGa4Groups } from "@/server/connections/manage";
import { decryptSecret } from "@/server/crypto";
import { createCompany, createVerifiedUser, pool, type TestUser, workerDeps } from "./helpers";

let U: TestUser;
let company: string;
let conn: string;
const KEY = Buffer.alloc(32, 7).toString("base64");
const SA = "mip-runtime@mkt-platform-prod-2.iam.gserviceaccount.com";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** Fake Google: records every call; the service account's first link attempt is refused (access not applied yet). */
function fakeGoogle(opts: { bindingFails?: boolean; linkFails?: boolean } = {}) {
  const calls: { method: string; url: string; auth: string; body: unknown }[] = [];
  let linkAttempts = 0;
  const f = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    const method = init?.method ?? "GET";
    const auth = ((init?.headers ?? {}) as Record<string, string>).authorization ?? "";
    let body: unknown = null;
    try {
      body = init?.body ? JSON.parse(String(init.body)) : null;
    } catch {
      body = String(init?.body); // the token request is form-encoded
    }
    calls.push({ method, url: u, auth, body });
    if (u.startsWith("https://oauth2.googleapis.com/token")) return json(200, { access_token: "user-token" });
    if (u.endsWith("/keyEvents?pageSize=200")) return json(200, { keyEvents: [{ eventName: "generate_lead" }] });
    if (u.includes("/bigQueryLinks?")) return json(200, {});
    if (u.endsWith("/accessBindings") && method === "POST")
      return opts.bindingFails ? json(403, { error: { status: "PERMISSION_DENIED", message: "user lacks manage users" } }) : json(200, { name: "properties/555/accessBindings/b1" });
    if (u.endsWith("/bigQueryLinks") && method === "POST") {
      linkAttempts++;
      if (opts.linkFails || linkAttempts === 1) return json(403, { error: { status: "PERMISSION_DENIED" } });
      return json(200, { name: "properties/555/bigQueryLinks/l1", project: "projects/123" });
    }
    if (method === "DELETE") return json(200, {});
    return json(404, { error: "unexpected " + u });
  });
  return { f, calls };
}

const deps = (f: typeof fetch) => ({
  fetch: f,
  google: { clientId: "id", clientSecret: "s" },
  encryptionKey: KEY,
  project: "mkt-platform-prod-2",
  location: "US",
  serviceAccountEmail: SA,
  platformToken: async () => "sa-token",
  sleep: async () => undefined,
});

beforeAll(async () => {
  U = await createVerifiedUser("ga4export");
  company = await createCompany(U, "GA4 Export Co");
  conn = (await pool.query(
    `insert into public.company_connections (workspace_id, company_id, provider_id, mode, status, external_account_id, activated_at)
     values ($1, $2, 'ga4', 'live', 'connected', '555', now()) returning id`,
    [U.workspaceId, company],
  )).rows[0].id;
});
afterAll(async () => {
  await pool.end();
});

describe("turning on GA4 full data", () => {
  it("the platform account gets access only while the link is created, and loses it again", async () => {
    const g = fakeGoogle();
    const r = await linkGa4Export(pool, deps(g.f as never), { connectionId: conn, userId: U.id, refreshToken: "1//user" });
    expect(r).toEqual({ status: "waiting_first_export", dataset: "analytics_555" });
    const added = g.calls.find((c) => c.url.endsWith("/accessBindings") && c.method === "POST")!;
    expect(added.auth).toBe("Bearer user-token");
    expect(added.body).toEqual({ user: SA, roles: ["predefinedRoles/editor"] });
    const links = g.calls.filter((c) => c.url.endsWith("/bigQueryLinks") && c.method === "POST");
    expect(links.map((c) => c.auth)).toEqual(["Bearer sa-token", "Bearer sa-token"]); // retried once the access applied
    const removed = g.calls.find((c) => c.method === "DELETE")!;
    expect(removed.url).toBe("https://analyticsadmin.googleapis.com/v1alpha/properties/555/accessBindings/b1");
    expect(g.calls.indexOf(removed)).toBeGreaterThan(g.calls.indexOf(links[1]!));

    const row = (await pool.query(`select * from public.ga4_export_links where connection_id = $1`, [conn])).rows[0];
    expect(row).toMatchObject({ status: "waiting_first_export", bq_project: "mkt-platform-prod-2", bq_dataset: "analytics_555", link_name: "properties/555/bigQueryLinks/l1", key_events: ["generate_lead"] });
    expect(decryptSecret(row.grant_ciphertext, KEY, `ga4export:${conn}`)).toBe("1//user");
  });

  it("with full data on, more than 9 breakdowns can be chosen", async () => {
    const d = await workerDeps();
    expect((await loadConnection(pool, U.id, conn))!.export?.status).toBe("waiting_first_export");
    const r = await setGa4Groups(pool, d.getWarehouse, U.id, conn, ["traffic_sources", "devices", "geo", "landing_pages"]);
    expect(r.changed).toBe(true);
  });

  it("a failed link still removes the platform's access and tells the user why", async () => {
    const g = fakeGoogle({ linkFails: true });
    const r = await linkGa4Export(pool, deps(g.f as never), { connectionId: conn, userId: U.id, refreshToken: "1//user" });
    expect(r.status).toBe("failed");
    expect(g.calls.some((c) => c.method === "DELETE" && c.url.endsWith("/accessBindings/b1"))).toBe(true);
    const row = (await pool.query(`select status, error from public.ga4_export_links where connection_id = $1`, [conn])).rows[0];
    expect(row.status).toBe("failed");
    expect(row.error).toMatch(/administrator/i);
  });

  it("without the Administrator role on GA4, nothing is changed and the user is told what is needed", async () => {
    const g = fakeGoogle({ bindingFails: true });
    const r = await linkGa4Export(pool, deps(g.f as never), { connectionId: conn, userId: U.id, refreshToken: "1//user" });
    expect(r).toMatchObject({ status: "failed", message: expect.stringMatching(/Administrator role/) });
    expect(g.calls.some((c) => c.url.endsWith("/bigQueryLinks") && c.method === "POST")).toBe(false);
  });

  it("turning off removes the link in GA4, deletes the exported events and forgets the grant", async () => {
    await linkGa4Export(pool, deps(fakeGoogle().f as never), { connectionId: conn, userId: U.id, refreshToken: "1//user" });
    const g = fakeGoogle();
    const deleted: string[] = [];
    const r = await removeGa4Export(pool, { fetch: g.f as never, google: { clientId: "id", clientSecret: "s" }, encryptionKey: KEY, deleteExportDataset: async (_p, ds) => void deleted.push(ds) }, conn);
    expect(r).toEqual({ removed: true, warning: null });
    expect(g.calls.find((c) => c.method === "DELETE")!.url).toBe("https://analyticsadmin.googleapis.com/v1alpha/properties/555/bigQueryLinks/l1");
    expect(deleted).toEqual(["analytics_555"]);
    const row = (await pool.query(`select status, grant_ciphertext from public.ga4_export_links where connection_id = $1`, [conn])).rows[0];
    expect(row).toEqual({ status: "removed", grant_ciphertext: null });
    expect((await loadConnection(pool, U.id, conn))!.export).toBeNull();
  });
});
