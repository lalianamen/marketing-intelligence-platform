import { Badge } from "./ui";
import { fmtDateTime } from "@/lib/format";

export interface LoadRun {
  status: string;
  attempts: number;
  error_code: string | null;
  run_after: string | Date;
}

const REASON: Record<string, string> = {
  auth_expired: "Google sign-in expired — reconnect",
  permission_denied: "no access to this account",
  rate_limited: "Google limit reached",
  quota_exceeded: "Google quota reached",
  unavailable: "Google temporarily unavailable",
  timeout: "took too long",
  incomplete_data: "incomplete data from the source",
  not_configured: "not set up",
};

export function reasonText(code: string | null): string {
  if (!code) return "unknown reason";
  if (code.startsWith("warehouse_")) return "storage error";
  return REASON[code] ?? code.replace(/_/g, " ");
}

/** What the user sees about a connector's current or last load. */
export function loadState(run: LoadRun | undefined, position: number | undefined, tz: string) {
  if (!run) return { tone: "gray" as const, text: "Not loaded yet", detail: null as string | null };
  if (run.status === "running") return { tone: "blue" as const, text: "Loading…", detail: null };
  if (run.status === "queued" && run.attempts > 0 && run.error_code) {
    return { tone: "amber" as const, text: "Load failed — retrying", detail: `${reasonText(run.error_code)}; next try about ${fmtDateTime(new Date(run.run_after).toISOString(), tz)}` };
  }
  if (run.status === "queued") return { tone: "blue" as const, text: position ? `In queue · #${position}` : "In queue", detail: null };
  if (run.status === "failed" || run.status === "dead") return { tone: "red" as const, text: "Load failed", detail: reasonText(run.error_code) };
  if (run.status === "succeeded") return { tone: "green" as const, text: "Up to date", detail: null };
  return { tone: "gray" as const, text: run.status, detail: null };
}

export function LoadStatus({ run, position, tz }: { run: LoadRun | undefined; position?: number; tz: string }) {
  const s = loadState(run, position, tz);
  return (
    <span className="inline-flex flex-col items-end gap-0.5 text-right" data-testid="load-status">
      <Badge tone={s.tone}>{s.text}</Badge>
      {s.detail && <span className="text-xs text-gray-500">{s.detail}</span>}
    </span>
  );
}
