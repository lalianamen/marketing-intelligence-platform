import { describe, expect, it } from "vitest";
import { loadState } from "@/components/LoadStatus";

const at = "2026-11-25T15:00:00Z";
describe("load status shown to users", () => {
  it("maps runs to plain words", () => {
    expect(loadState(undefined, undefined, "UTC").text).toBe("Not loaded yet");
    expect(loadState({ status: "queued", attempts: 0, error_code: null, run_after: at }, 3, "UTC").text).toBe("In queue · #3");
    expect(loadState({ status: "running", attempts: 1, error_code: null, run_after: at }, undefined, "UTC").text).toBe("Loading…");
    const retry = loadState({ status: "queued", attempts: 2, error_code: "rate_limited", run_after: at }, 1, "America/Los_Angeles");
    expect(retry.text).toBe("Load failed — retrying");
    expect(retry.detail).toContain("Google limit reached");
    expect(retry.detail).toContain("7:00 AM");
    expect(loadState({ status: "dead", attempts: 5, error_code: "auth_expired", run_after: at }, undefined, "UTC")).toMatchObject({ text: "Load failed", tone: "red" });
    expect(loadState({ status: "succeeded", attempts: 1, error_code: null, run_after: at }, undefined, "UTC").text).toBe("Up to date");
  });
});
