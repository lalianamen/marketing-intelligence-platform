import "server-only";
import { after } from "next/server";
import { inlineJobsEnabled, runPendingWork } from "./runner";

/** After the response is sent, process the work the user just queued. */
export function kickJobs(): void {
  if (!inlineJobsEnabled()) return;
  after(async () => {
    try {
      await runPendingWork({ budgetMs: 25_000 });
    } catch (err) {
      console.error(JSON.stringify({ level: "error", msg: "inline_jobs_failed", error: (err as Error).message }));
    }
  });
}
