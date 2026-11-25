import { ConnectorError, connectorErrorFromHttp } from "./types";
import type { FetchLike } from "./google";

// Google Analytics Admin API calls used to turn on GA4's own BigQuery export
// (ADR 0006). Every call is made with an explicit access token: the user's
// (to add / remove the platform's service account on their property, and to
// read their key events) or the platform service account's (to create the link,
// which Google allows only to an owner of the receiving Cloud project).

const ADMIN = "https://analyticsadmin.googleapis.com";

export const GA4_EDIT_SCOPE = "https://www.googleapis.com/auth/analytics.edit";
export const GA4_MANAGE_USERS_SCOPE = "https://www.googleapis.com/auth/analytics.manage.users";

function propertyPath(propertyId: string): string {
  if (!/^\d{1,20}$/.test(propertyId)) throw new ConnectorError("invalid_request", "ga4 admin: property id must be numeric");
  return `properties/${propertyId}`;
}

async function call(f: FetchLike, method: "GET" | "POST" | "DELETE", url: string, token: string, body?: unknown): Promise<unknown> {
  let res: Response;
  try {
    res = await f(url, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    throw new ConnectorError("timeout", `ga4 admin: ${(err as Error).name}`);
  }
  const text = await res.text();
  if (!res.ok) {
    if (/SERVICE_DISABLED|has not been used in project|is disabled/.test(text)) {
      const project = /projects?[ /=]+(\d{6,})/.exec(text)?.[1];
      throw new ConnectorError("not_configured", `ga4 admin: the Google Analytics Admin API is not enabled${project ? ` (project number ${project})` : ""}`);
    }
    throw connectorErrorFromHttp(res.status, text, "ga4 admin");
  }
  return text ? JSON.parse(text) : {};
}

/** Gives `email` the Editor role on the property (user token with analytics.manage.users). Returns the binding name. */
export async function addPropertyEditor(f: FetchLike, userToken: string, propertyId: string, email: string): Promise<string> {
  const json = (await call(f, "POST", `${ADMIN}/v1alpha/${propertyPath(propertyId)}/accessBindings`, userToken, {
    user: email,
    roles: ["predefinedRoles/editor"],
  })) as { name?: string };
  if (!json.name) throw new ConnectorError("unavailable", "ga4 admin: access binding was not created");
  return json.name;
}

/** Removes an access binding created by addPropertyEditor. */
export async function removeAccessBinding(f: FetchLike, userToken: string, bindingName: string): Promise<void> {
  if (!/^properties\/\d{1,20}\/accessBindings\/[A-Za-z0-9_=+\/-]{1,300}$/.test(bindingName)) throw new ConnectorError("invalid_request", "ga4 admin: bad binding name");
  await call(f, "DELETE", `${ADMIN}/v1alpha/${bindingName}`, userToken);
}

export interface BigQueryLink {
  name: string;
  project: string;
  datasetLocation?: string;
  dailyExportEnabled?: boolean;
}

export async function listBigQueryLinks(f: FetchLike, token: string, propertyId: string): Promise<BigQueryLink[]> {
  const json = (await call(f, "GET", `${ADMIN}/v1alpha/${propertyPath(propertyId)}/bigQueryLinks?pageSize=50`, token)) as { bigqueryLinks?: BigQueryLink[] };
  return json.bigqueryLinks ?? [];
}

/** Creates the daily export link to `project` (platform service account token, analytics.edit). */
export async function createBigQueryLink(f: FetchLike, token: string, propertyId: string, project: string, location: string): Promise<BigQueryLink> {
  return (await call(f, "POST", `${ADMIN}/v1alpha/${propertyPath(propertyId)}/bigQueryLinks`, token, {
    project: `projects/${project}`,
    dailyExportEnabled: true,
    streamingExportEnabled: false,
    freshDailyExportEnabled: false,
    includeAdvertisingId: false,
    datasetLocation: location,
  })) as BigQueryLink;
}

export async function deleteBigQueryLink(f: FetchLike, token: string, linkName: string): Promise<void> {
  if (!/^properties\/\d{1,20}\/bigQueryLinks\/[A-Za-z0-9_=+\/-]{1,300}$/.test(linkName)) throw new ConnectorError("invalid_request", "ga4 admin: bad link name");
  await call(f, "DELETE", `${ADMIN}/v1alpha/${linkName}`, token);
}

/** Event names the property marks as key events (they are counted as keyEvents). */
export async function listKeyEvents(f: FetchLike, token: string, propertyId: string): Promise<string[]> {
  const json = (await call(f, "GET", `${ADMIN}/v1beta/${propertyPath(propertyId)}/keyEvents?pageSize=200`, token)) as { keyEvents?: { eventName?: string }[] };
  return (json.keyEvents ?? []).map((k) => k.eventName ?? "").filter((n) => /^[A-Za-z0-9_]{1,64}$/.test(n));
}
