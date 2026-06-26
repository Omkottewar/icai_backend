// Minimal recurrence expansion for branch events.
//
// We deliberately don't use a full RRULE engine — the branch's actual
// patterns are simple ("weekly study circle for 8 weeks", "monthly
// fellowship meet for the year"). Supporting just the three frequencies
// below covers every requested case and keeps the surface tiny.
//
// The stored `recurrence_rrule` column is still RFC-5545 formatted so a
// future swap to rrule.js stays compatible.

export type RecurrenceFreq = "DAILY" | "WEEKLY" | "MONTHLY";

export interface RecurrenceSpec {
  freq: RecurrenceFreq;
  interval?: number;   // default 1
  count?: number;      // total occurrences (including the seed)
  until?: Date | null; // stop on or before this date (UTC midnight)
}

/** Render the spec back into an RFC-5545 RRULE string for storage. */
export function specToRrule(spec: RecurrenceSpec): string {
  const parts = [`FREQ=${spec.freq}`];
  if (spec.interval && spec.interval > 1) parts.push(`INTERVAL=${spec.interval}`);
  if (spec.count && spec.count > 0)       parts.push(`COUNT=${spec.count}`);
  if (spec.until) {
    const u = new Date(spec.until);
    const iso = u.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
    parts.push(`UNTIL=${iso}`);
  }
  return parts.join(";");
}

/**
 * Expand a recurrence spec starting from `seedStart`, returning every
 * (start, end) pair INCLUDING the seed occurrence at index 0. Duration is
 * preserved across the series. Hard caps at 365 occurrences as a safety net.
 */
export function expandRecurrence(
  seedStart: Date,
  seedEnd: Date,
  spec: RecurrenceSpec,
): Array<{ start: Date; end: Date }> {
  const interval = Math.max(1, spec.interval ?? 1);
  const duration = seedEnd.getTime() - seedStart.getTime();
  const limit = Math.min(365, spec.count ?? 365);
  const untilMs = spec.until ? new Date(spec.until).getTime() : Number.POSITIVE_INFINITY;

  const out: Array<{ start: Date; end: Date }> = [];
  let cursor = new Date(seedStart);

  for (let i = 0; i < limit; i++) {
    if (cursor.getTime() > untilMs) break;
    out.push({ start: new Date(cursor), end: new Date(cursor.getTime() + duration) });

    // Step to the next occurrence.
    const next = new Date(cursor);
    if (spec.freq === "DAILY") {
      next.setUTCDate(next.getUTCDate() + interval);
    } else if (spec.freq === "WEEKLY") {
      next.setUTCDate(next.getUTCDate() + 7 * interval);
    } else if (spec.freq === "MONTHLY") {
      next.setUTCMonth(next.getUTCMonth() + interval);
    }
    cursor = next;
  }
  return out;
}
