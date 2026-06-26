// RFC-5545 iCalendar generator — minimal, no external dependency.
//
// Two surfaces use this:
//   1. /api/events/:slug/ical    — single-event .ics download (Add to Calendar)
//   2. /api/events/my-calendar.ics?token=…  — per-user subscription feed
//
// Output is sufficient for Google Calendar, Apple Calendar, Outlook. We
// intentionally avoid VTIMEZONE blocks — every DTSTART/DTEND is emitted in
// UTC ("Z" suffix) which calendars convert to the viewer's local time.
// This keeps the file tiny and avoids the timezone-database minefield.

export interface IcalEvent {
  uid: string;           // stable per (event, optionally per user)
  title: string;
  description?: string | null;
  location?: string | null;
  url?: string | null;
  start: Date;
  end: Date;
  organizerEmail?: string;
  organizerName?: string;
  status?: "CONFIRMED" | "TENTATIVE" | "CANCELLED";
}

// RFC-5545 line folding: hard wrap at 75 octets, continuation lines start
// with a single space.
function fold(line: string): string {
  if (line.length <= 75) return line;
  const out: string[] = [];
  let i = 0;
  while (i < line.length) {
    out.push((out.length === 0 ? "" : " ") + line.slice(i, i + (out.length === 0 ? 75 : 74)));
    i += out.length === 0 ? 75 : 74;
  }
  return out.join("\r\n");
}

// Escape commas, semicolons, backslashes, newlines per spec.
function escapeText(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/,/g, "\\,")
    .replace(/;/g, "\\;");
}

function formatUtc(d: Date): string {
  // YYYYMMDDTHHmmssZ
  const iso = d.toISOString();
  return iso.replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function emit(line: string): string {
  return fold(line);
}

function buildEvent(e: IcalEvent): string[] {
  const lines: string[] = [];
  lines.push("BEGIN:VEVENT");
  lines.push(emit(`UID:${e.uid}`));
  lines.push(emit(`DTSTAMP:${formatUtc(new Date())}`));
  lines.push(emit(`DTSTART:${formatUtc(e.start)}`));
  lines.push(emit(`DTEND:${formatUtc(e.end)}`));
  lines.push(emit(`SUMMARY:${escapeText(e.title)}`));
  if (e.description) lines.push(emit(`DESCRIPTION:${escapeText(e.description)}`));
  if (e.location)    lines.push(emit(`LOCATION:${escapeText(e.location)}`));
  if (e.url)         lines.push(emit(`URL:${e.url}`));
  if (e.organizerEmail) {
    const cn = e.organizerName ? `;CN=${escapeText(e.organizerName)}` : "";
    lines.push(emit(`ORGANIZER${cn}:mailto:${e.organizerEmail}`));
  }
  lines.push(`STATUS:${e.status ?? "CONFIRMED"}`);
  lines.push("END:VEVENT");
  return lines;
}

/**
 * Produce a complete .ics document body. `calendarName` shows up as the
 * subscription's display name in most clients (Apple, Google).
 */
export function buildCalendar(events: IcalEvent[], calendarName: string): string {
  const lines: string[] = [];
  lines.push("BEGIN:VCALENDAR");
  lines.push("VERSION:2.0");
  lines.push("PRODID:-//ICAI Nagpur Branch//Portal//EN");
  lines.push("CALSCALE:GREGORIAN");
  lines.push("METHOD:PUBLISH");
  lines.push(emit(`X-WR-CALNAME:${escapeText(calendarName)}`));
  lines.push("X-PUBLISHED-TTL:PT1H");
  for (const ev of events) lines.push(...buildEvent(ev));
  lines.push("END:VCALENDAR");
  return lines.join("\r\n") + "\r\n";
}
