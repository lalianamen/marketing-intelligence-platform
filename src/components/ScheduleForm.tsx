"use client";

import { useState } from "react";
import { SubmitButton } from "./SubmitButton";

/**
 * Daily time / manual-only form that always shows what is saved, marks unsaved
 * changes, and confirms a save right next to the button.
 */
export function ScheduleForm({
  action,
  connectionId,
  saved,
  timezone,
  nextRunText,
  justSaved,
}: {
  action: (form: FormData) => Promise<void>;
  connectionId: string;
  saved: { frequency: "daily" | "manual"; localTime: string };
  timezone: string;
  nextRunText: string;
  justSaved: boolean;
}) {
  const [frequency, setFrequency] = useState(saved.frequency);
  const [time, setTime] = useState(saved.localTime);
  const dirty = frequency !== saved.frequency || (frequency === "daily" && time !== saved.localTime);
  const savedText = saved.frequency === "daily" ? `every day at ${to12h(saved.localTime)} (${timezone})` : "only when you press “Update now”";

  return (
    <form action={action} className="space-y-3" data-testid="schedule-form">
      <input type="hidden" name="connection_id" value={connectionId} />
      <p className="rounded-lg bg-green-50 px-3 py-2 text-sm text-green-900 ring-1 ring-green-200" data-testid="schedule-current">
        <strong>Now:</strong> updates {savedText}. {nextRunText}
      </p>
      <fieldset className="flex flex-wrap items-center gap-4 text-sm">
        <label className="flex items-center gap-2">
          <input type="radio" name="frequency" value="daily" checked={frequency === "daily"} onChange={() => setFrequency("daily")} /> Every day at
        </label>
        <input
          type="time"
          name="local_time"
          value={time}
          onChange={(e) => {
            setTime(e.target.value);
            setFrequency("daily");
          }}
          required
          className="rounded-lg border border-gray-300 px-2 py-1 text-sm"
        />
        <span className="text-gray-500">{timezone}</span>
      </fieldset>
      <label className="flex items-center gap-2 text-sm">
        <input type="radio" name="frequency" value="manual" checked={frequency === "manual"} onChange={() => setFrequency("manual")} /> Only when I press “Update now”
      </label>
      <p className="text-xs text-gray-500">Each update re-reads the recent days, because platforms keep adjusting them for a while.</p>
      <div className="flex items-center gap-3">
        <SubmitButton pendingText="Saving…" disabled={!dirty}>Save</SubmitButton>
        {dirty ? (
          <span className="text-sm font-medium text-amber-700" data-testid="schedule-unsaved">Unsaved changes</span>
        ) : justSaved ? (
          <span className="text-sm font-medium text-green-700" data-testid="schedule-saved">✓ Saved</span>
        ) : null}
      </div>
    </form>
  );
}

function to12h(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return hhmm;
  return `${((h! + 11) % 12) + 1}:${String(m).padStart(2, "0")} ${h! < 12 ? "AM" : "PM"}`;
}
