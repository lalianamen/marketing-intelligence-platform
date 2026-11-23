// Deterministic, collision-resistant dataset IDs.
// Deterministic (derived from the company UUID) so that a retried provisioning
// job targets the SAME dataset instead of creating a duplicate. Collision
// resistance comes from the UUID (122 random bits). The environment prefix
// keeps dev/test/prod datasets apart inside a shared project.
// BigQuery rule: letters, numbers, underscores; up to 1,024 chars.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function datasetIdForCompany(prefix: string, companyId: string): string {
  if (!/^[a-z][a-z0-9_]{0,30}$/.test(prefix)) throw new Error("invalid dataset prefix");
  if (!UUID_RE.test(companyId)) throw new Error("companyId must be a UUID");
  return `${prefix}_c_${companyId.toLowerCase().replace(/-/g, "")}`;
}

export function isSafeIdentifier(id: string): boolean {
  return /^[A-Za-z0-9_]{1,1024}$/.test(id);
}

/** For SQL identifiers that cannot be parameterized (dataset/project names). */
export function assertSafeIdentifier(id: string, what = "identifier"): string {
  if (!isSafeIdentifier(id)) throw new Error(`unsafe ${what}`);
  return id;
}

export function assertSafeProjectId(id: string): string {
  // GCP project IDs: 6-30 chars, lowercase letters, digits, hyphens. Domain-scoped
  // ("example.com:proj") projects are not supported here.
  if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(id) && id !== "local") throw new Error("unsafe project id");
  return id;
}
