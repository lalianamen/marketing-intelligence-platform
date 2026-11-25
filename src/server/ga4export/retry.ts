import type { Queryable } from "../db";
import { type FetchLike, refreshAccessToken } from "../connectors/google";
import { removeAccessBinding } from "../connectors/ga4Admin";

// No "server-only" here: this runs inside the background worker too.

/**
 * Removes the platform's temporary GA4 access if an earlier attempt could not
 * (called at the start of every load of the connector). Returns true when removed.
 */
export async function retryPendingAccessRemoval(
  db: Queryable,
  deps: { fetch?: FetchLike; google: { clientId: string; clientSecret: string }; encryptionKey: string },
  connectionId: string,
): Promise<boolean> {
  const row = (
    await db.query<{ pending_binding: string | null; grant_ciphertext: string | null }>(
      `select pending_binding, grant_ciphertext from public.ga4_export_links where connection_id = $1`,
      [connectionId],
    )
  ).rows[0];
  if (!row?.pending_binding || !row.grant_ciphertext) return false;
  const f = deps.fetch ?? fetch;
  try {
    const { decryptSecret } = await import("../crypto");
    const token = await refreshAccessToken({ ...deps.google, fetch: f }, decryptSecret(row.grant_ciphertext, deps.encryptionKey, `ga4export:${connectionId}`));
    await removeAccessBinding(f, token, row.pending_binding);
  } catch (err) {
    // Already gone counts as removed.
    if (!/404|NOT_FOUND/.test(String((err as Error).message))) {
      console.error(JSON.stringify({ level: "warn", msg: "ga4export.binding_retry_failed", connection_id: connectionId, error: String((err as Error).message).slice(0, 300) }));
      return false;
    }
  }
  await db.query(`update public.ga4_export_links set pending_binding = null, updated_at = now() where connection_id = $1`, [connectionId]);
  return true;
}
