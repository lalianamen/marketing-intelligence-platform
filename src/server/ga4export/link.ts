import "server-only";
import type { Queryable } from "../db";
import { encryptSecret } from "../crypto";
import { type FetchLike, refreshAccessToken } from "../connectors/google";
import { ConnectorError } from "../connectors/types";
import {
  addPropertyEditor,
  createBigQueryLink,
  deleteBigQueryLink,
  GA4_EDIT_SCOPE,
  listBigQueryLinks,
  listKeyEvents,
  removeAccessBinding,
} from "../connectors/ga4Admin";

// Turning on GA4's own BigQuery export for one connection (ADR 0006).
// Google lets only an owner of the receiving Cloud project create the link, and
// that project is the platform's. So, with the user's consent:
//   1. the user's token adds the platform service account to the property as Editor,
//   2. the service account creates the daily export link to the platform project,
//   3. the user's token removes the service account again (always, also on failure).
// Nothing else in the property is changed. The user's token is kept encrypted only
// to remove the link when the connector is deleted.

export interface ExportLinkDeps {
  fetch?: FetchLike;
  google: { clientId: string; clientSecret: string };
  encryptionKey: string;
  project: string;
  location: string;
  serviceAccountEmail: string;
  platformToken: (scopes: string[]) => Promise<string>;
  sleep?: (ms: number) => Promise<void>;
}

export type ExportLinkResult = { status: "waiting_first_export" | "active"; dataset: string } | { status: "failed"; message: string };

/** Plain explanation for the user; technical detail stays in the server log. */
export function exportErrorMessage(err: unknown): string {
  const e = err as ConnectorError;
  const text = String(e?.message ?? "");
  if (e?.code === "auth_expired") return "Google sign-in expired. Please try again.";
  if (e?.code === "not_configured") return "The platform's Google Cloud project is not set up for this yet (administrator: enable the Google Analytics Admin API).";
  if (/accessBindings/.test(text) || (e?.code === "permission_denied" && /binding|manage/i.test(text)))
    return "Your Google account needs the Administrator role on this GA4 property to turn on full data. Ask the property's administrator, or sign in with their account.";
  if (e?.code === "permission_denied")
    return "Google did not allow the platform to create the export link (administrator: the platform service account needs permission on its Cloud project).";
  if (/limit|maximum|quota/i.test(text)) return "This GA4 property already has the maximum number of BigQuery links. Remove an old link in GA4 (Admin → BigQuery links) and try again.";
  return "Google could not turn on the export right now. Please try again in a few minutes.";
}

export async function linkGa4Export(
  db: Queryable,
  deps: ExportLinkDeps,
  input: { connectionId: string; userId: string; refreshToken: string },
): Promise<ExportLinkResult> {
  const conn = (
    await db.query<{ id: string; workspace_id: string; company_id: string; external_account_id: string; provider_id: string; mode: string }>(
      `select id, workspace_id, company_id, external_account_id, provider_id, mode from public.company_connections where id = $1`,
      [input.connectionId],
    )
  ).rows[0];
  if (!conn || conn.provider_id !== "ga4" || conn.mode !== "live" || !/^\d{1,20}$/.test(conn.external_account_id ?? "")) {
    return { status: "failed", message: "This connector cannot use the GA4 export." };
  }
  const propertyId = conn.external_account_id;
  const dataset = `analytics_${propertyId}`;
  const f = deps.fetch ?? fetch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const save = (status: string, extra: Record<string, unknown> = {}) =>
    db.query(
      `insert into public.ga4_export_links (connection_id, workspace_id, company_id, property_id, status, bq_project, bq_dataset, bq_location,
         link_name, grant_ciphertext, key_events, error, requested_by, linked_at, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, coalesce($11::text[], '{}'), $12, $13, $14, now())
       on conflict (connection_id) do update set status = excluded.status, bq_project = excluded.bq_project, bq_dataset = excluded.bq_dataset,
         bq_location = excluded.bq_location, link_name = coalesce(excluded.link_name, ga4_export_links.link_name),
         grant_ciphertext = coalesce(excluded.grant_ciphertext, ga4_export_links.grant_ciphertext),
         key_events = case when $11::text[] is null then ga4_export_links.key_events else excluded.key_events end,
         error = excluded.error, requested_by = excluded.requested_by,
         linked_at = coalesce(excluded.linked_at, ga4_export_links.linked_at), updated_at = now()`,
      [
        conn.id, conn.workspace_id, conn.company_id, propertyId, status, deps.project, dataset, deps.location,
        (extra.linkName as string | undefined) ?? null,
        encryptSecret(input.refreshToken, deps.encryptionKey, `ga4export:${conn.id}`),
        (extra.keyEvents as string[] | undefined) ?? null,
        (extra.error as string | undefined) ?? null,
        input.userId,
        extra.linked ? new Date() : null,
      ],
    );
  await save("linking");

  let binding: string | null = null;
  let userToken: string;
  try {
    userToken = await refreshAccessToken({ ...deps.google, fetch: f }, input.refreshToken);
    const keyEvents = await listKeyEvents(f, userToken, propertyId).catch(() => [] as string[]);

    // Already linked to the platform project (e.g. a second attempt)? Then nothing to create.
    const existing = (await listBigQueryLinks(f, userToken, propertyId).catch(() => [])).find(
      (l) => l.project === `projects/${deps.project}` || l.project?.endsWith(`/${deps.project}`),
    );
    let linkName = existing?.name ?? null;
    if (!linkName) {
      binding = await addPropertyEditor(f, userToken, propertyId, deps.serviceAccountEmail).catch((err) => {
        throw Object.assign(err as Error, { message: `accessBindings: ${(err as Error).message}` });
      });
      const saToken = await deps.platformToken([GA4_EDIT_SCOPE]);
      // A new access binding can take a few seconds to apply.
      let last: unknown = null;
      for (let i = 0; i < 4 && !linkName; i++) {
        try {
          linkName = (await createBigQueryLink(f, saToken, propertyId, deps.project, deps.location)).name ?? null;
        } catch (err) {
          last = err;
          const e = err as ConnectorError;
          if (/ALREADY_EXISTS|409/.test(e.message ?? "")) {
            linkName = (await listBigQueryLinks(f, saToken, propertyId)).find((l) => l.project?.endsWith(`/${deps.project}`))?.name ?? null;
            if (linkName) break;
          }
          if (e.code !== "permission_denied") throw err;
          await sleep(3000 * (i + 1));
        }
      }
      if (!linkName) throw last ?? new ConnectorError("unavailable", "ga4 admin: link was not created");
    }
    await save("waiting_first_export", { linkName, keyEvents, linked: true });
    return { status: "waiting_first_export", dataset };
  } catch (err) {
    const message = exportErrorMessage(err);
    console.error(JSON.stringify({ level: "warn", msg: "ga4export.link_failed", connection_id: conn.id, code: (err as ConnectorError).code, error: String((err as Error).message).slice(0, 300) }));
    await save("failed", { error: message });
    return { status: "failed", message };
  } finally {
    if (binding) {
      // Always take the platform's access away again.
      try {
        await removeAccessBinding(f, userToken!, binding);
      } catch (err) {
        console.error(JSON.stringify({ level: "error", msg: "ga4export.binding_not_removed", connection_id: conn.id, binding, error: String((err as Error).message).slice(0, 300) }));
        // Retried on the next load of the connector (retryPendingAccessRemoval).
        await db.query(`update public.ga4_export_links set pending_binding = $2 where connection_id = $1`, [conn.id, binding]);
      }
    }
  }
}

/**
 * Turns the export off: the link is removed in GA4 with the stored grant of the user
 * who turned it on, and the exported events are deleted from the platform's BigQuery.
 * Returns a message for the user when part of it could not be done automatically.
 */
export async function removeGa4Export(
  db: Queryable,
  deps: { fetch?: FetchLike; google: { clientId: string; clientSecret: string }; encryptionKey: string; deleteExportDataset: (project: string, dataset: string, location: string) => Promise<void> },
  connectionId: string,
): Promise<{ removed: boolean; warning: string | null }> {
  const link = (
    await db.query<{ property_id: string; link_name: string | null; grant_ciphertext: string | null; bq_project: string | null; bq_dataset: string | null; bq_location: string | null; status: string }>(
      `select property_id, link_name, grant_ciphertext, bq_project, bq_dataset, bq_location, status from public.ga4_export_links where connection_id = $1`,
      [connectionId],
    )
  ).rows[0];
  if (!link || link.status === "removed") return { removed: false, warning: null };
  const f = deps.fetch ?? fetch;
  const warnings: string[] = [];
  if (link.link_name && link.grant_ciphertext) {
    try {
      const { decryptSecret } = await import("../crypto");
      const token = await refreshAccessToken({ ...deps.google, fetch: f }, decryptSecret(link.grant_ciphertext, deps.encryptionKey, `ga4export:${connectionId}`));
      await deleteBigQueryLink(f, token, link.link_name);
    } catch (err) {
      if ((err as ConnectorError).code !== "invalid_request" || !/404|NOT_FOUND/.test((err as Error).message)) {
        console.error(JSON.stringify({ level: "warn", msg: "ga4export.unlink_failed", connection_id: connectionId, error: String((err as Error).message).slice(0, 300) }));
        warnings.push("The export link could not be removed in GA4 automatically: remove it in GA4 Admin → Product links → BigQuery links.");
      }
    }
  }
  if (link.bq_project && link.bq_dataset === `analytics_${link.property_id}`) {
    try {
      await deps.deleteExportDataset(link.bq_project, link.bq_dataset, link.bq_location ?? "US");
    } catch (err) {
      console.error(JSON.stringify({ level: "warn", msg: "ga4export.dataset_not_deleted", connection_id: connectionId, error: String((err as Error).message).slice(0, 300) }));
      warnings.push("The exported events could not be deleted automatically; the administrator was notified in the log.");
    }
  }
  await db.query(
    `update public.ga4_export_links set status = 'removed', grant_ciphertext = null, updated_at = now() where connection_id = $1`,
    [connectionId],
  );
  return { removed: true, warning: warnings.length ? warnings.join(" ") : null };
}
