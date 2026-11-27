import "server-only";
import type { Queryable } from "../db";
import { encryptSecret } from "../crypto";
import type { DiscoveredAccount } from "../connectors/google";

export type GoogleProvider = "ga4" | "google_ads" | "google_search_console";
export type LiveProvider = GoogleProvider | "microsoft_clarity" | "stripe" | "bing_webmaster" | "meta_ads";

export function defaultAccountName(provider: GoogleProvider, id: string): string {
  if (provider === "google_search_console") return id;
  return provider === "ga4" ? `GA4 property ${id}` : `Google Ads ${id.replace(/(\d{3})(\d{3})(\d{4})/, "$1-$2-$3")}`;
}

/**
 * Creates (or reconnects) one live connection with its own encrypted copy of the
 * refresh token and a daily schedule. Runs inside the caller's transaction.
 */
export async function createLiveConnection(
  c: Queryable,
  args: {
    workspaceId: string;
    companyId: string;
    userId: string;
    provider: LiveProvider;
    account: DiscoveredAccount;
    /** Default time of the daily update (e.g. right after midnight for Clarity). */
    localTime?: string;
    refreshToken: string;
    scopes: string[];
    encryptionKey: string;
  },
): Promise<string> {
  const name = (args.account.group ? `${args.account.name} · ${args.account.group}` : args.account.name).slice(0, 200);
  const conn = await c.query<{ id: string }>(
    `insert into public.company_connections (workspace_id, company_id, provider_id, mode, status, external_account_id, external_account_name, scopes, created_by, activated_at)
     values ($1, $2, $3, 'live', 'connected', $4, $5, $6, $7, null)
     on conflict (company_id, provider_id, mode, coalesce(external_account_id, ''))
     do update set status = 'connected', external_account_name = excluded.external_account_name, scopes = excluded.scopes,
                   -- a connector the user had disconnected goes through setup again
                   activated_at = case when public.company_connections.status = 'disconnected' then null else public.company_connections.activated_at end,
                   last_error = null, consecutive_failures = 0, updated_at = now()
     returning id`,
    [args.workspaceId, args.companyId, args.provider, args.account.id, name, args.scopes, args.userId],
  );
  const id = conn.rows[0]!.id;
  await c.query(
    `insert into public.connection_secrets (connection_id, workspace_id, company_id, ciphertext)
     values ($1, $2, $3, $4)
     on conflict (connection_id) do update set ciphertext = excluded.ciphertext, updated_at = now()`,
    [id, args.workspaceId, args.companyId, encryptSecret(args.refreshToken, args.encryptionKey, id)],
  );
  // New connectors start with the schedule off: nothing loads until the user finishes setup.
  // Reconnecting an existing connector (e.g. after the Google sign-in expired) keeps its schedule.
  await c.query(
    `insert into public.sync_schedules (workspace_id, company_id, connection_id, frequency, local_time, timezone, buffer_minutes, next_run_at, enabled)
     select $1, $2, $3, 'daily', coalesce($5::time, s.sync_local_time, '06:00'), co.timezone, $4, null, false
       from public.companies co left join public.company_settings s on s.company_id = co.id where co.id = $2
     on conflict (connection_id) do update
       set next_run_at = case when public.sync_schedules.enabled then now() else public.sync_schedules.next_run_at end, updated_at = now()`,
    [args.workspaceId, args.companyId, id, args.provider === "ga4" ? 60 : args.provider === "microsoft_clarity" ? 0 : 30, args.localTime ?? null],
  );
  await c.query(
    `insert into public.audit_logs (workspace_id, company_id, actor_user_id, action, target_type, target_id, metadata)
     values ($1, $2, $3, 'connection.live_connected', 'connection', $4, $5)`,
    [args.workspaceId, args.companyId, args.userId, id, JSON.stringify({ provider: args.provider })],
  );
  return id;
}
