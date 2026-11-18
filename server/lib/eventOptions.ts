// Per-event options kept outside the `events` table (so that table and every
// query selecting from it stay unchanged):
//   pay_at_venue          — offer "pay at venue" after a failed online payment
//   allow_non_members     — non-members (no ICAI membership number) may register
//   non_member_fee_paise  — their fee before GST; null = same as the member fee
// The table is created / extended on first use (also migrations 0108, 0109).

import { sql } from "drizzle-orm";
import { db } from "../../db/client.js";

export type EventOptions = {
  pay_at_venue: boolean;
  allow_non_members: boolean;
  non_member_fee_paise: number | null;
};

export const DEFAULT_EVENT_OPTIONS: EventOptions = { pay_at_venue: false, allow_non_members: false, non_member_fee_paise: null };

let ready: Promise<void> | null = null;
export function ensureEventOptionsTable(): Promise<void> {
  ready ??= db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS "event_payment_options" (
      "event_id" uuid PRIMARY KEY REFERENCES "events"("id") ON DELETE CASCADE,
      "pay_at_venue" boolean NOT NULL DEFAULT false,
      "updated_at" timestamptz NOT NULL DEFAULT now()
    );
    ALTER TABLE "event_payment_options" ADD COLUMN IF NOT EXISTS "allow_non_members" boolean NOT NULL DEFAULT false;
    ALTER TABLE "event_payment_options" ADD COLUMN IF NOT EXISTS "non_member_fee_paise" integer;
  `)).then(() => undefined).catch((e) => { ready = null; throw e; });
  return ready;
}

type Row = { event_id: string; pay_at_venue: boolean; allow_non_members: boolean; non_member_fee_paise: number | null };

export async function getEventOptions(eventId: string): Promise<EventOptions> {
  return (await getEventOptionsMap([eventId])).get(eventId) ?? { ...DEFAULT_EVENT_OPTIONS };
}

export async function getEventOptionsMap(eventIds: string[]): Promise<Map<string, EventOptions>> {
  const map = new Map<string, EventOptions>();
  if (eventIds.length === 0) return map;
  await ensureEventOptionsTable();
  const rows = (await db.execute(sql`
    SELECT event_id, pay_at_venue, allow_non_members, non_member_fee_paise
    FROM event_payment_options
    WHERE event_id IN (${sql.join(eventIds.map((id) => sql`${id}::uuid`), sql`, `)})`)) as unknown as Row[];
  for (const r of rows) {
    map.set(r.event_id, {
      pay_at_venue: Boolean(r.pay_at_venue),
      allow_non_members: Boolean(r.allow_non_members),
      non_member_fee_paise: r.non_member_fee_paise == null ? null : Number(r.non_member_fee_paise),
    });
  }
  return map;
}

export async function setEventOptions(eventId: string, patch: Partial<EventOptions>): Promise<EventOptions> {
  const next = { ...(await getEventOptions(eventId)), ...patch };
  await db.execute(sql`
    INSERT INTO event_payment_options (event_id, pay_at_venue, allow_non_members, non_member_fee_paise, updated_at)
    VALUES (${eventId}, ${next.pay_at_venue}, ${next.allow_non_members}, ${next.non_member_fee_paise}, now())
    ON CONFLICT (event_id) DO UPDATE SET
      pay_at_venue = EXCLUDED.pay_at_venue,
      allow_non_members = EXCLUDED.allow_non_members,
      non_member_fee_paise = EXCLUDED.non_member_fee_paise,
      updated_at = now()`);
  return next;
}
