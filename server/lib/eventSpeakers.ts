// Extra speakers for an event (the first speaker stays in events.speaker_*).
// Kept in its own table so the `events` table and every query on it stay
// unchanged. The table is created on first use (also migration 0110).

import { sql } from "drizzle-orm";
import { db } from "../../db/client.js";
import { storage } from "./storage.js";
import { ApiError } from "./apiError.js";

export type ExtraSpeaker = {
  name: string;
  bio: string | null;
  photo_id: string | null;
  photo_url?: string | null;
};

const MAX_EXTRA = 9;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let ready: Promise<void> | null = null;
export function ensureEventSpeakersTable(): Promise<void> {
  ready ??= db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS "event_extra_speakers" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "event_id" uuid NOT NULL REFERENCES "events"("id") ON DELETE CASCADE,
      "position" integer NOT NULL,
      "name" text NOT NULL,
      "bio" text,
      "photo_id" uuid REFERENCES "files"("id") ON DELETE SET NULL,
      "created_at" timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS "event_extra_speakers_event_idx" ON "event_extra_speakers" ("event_id", "position");
  `)).then(() => undefined).catch((e) => { ready = null; throw e; });
  return ready;
}

type Row = { event_id: string; name: string; bio: string | null; photo_id: string | null; storage_path: string | null };

export async function getExtraSpeakersMap(eventIds: string[]): Promise<Map<string, ExtraSpeaker[]>> {
  const map = new Map<string, ExtraSpeaker[]>();
  if (eventIds.length === 0) return map;
  await ensureEventSpeakersTable();
  const rows = (await db.execute(sql`
    SELECT s.event_id, s.name, s.bio, s.photo_id, f.storage_path
    FROM event_extra_speakers s
    LEFT JOIN files f ON f.id = s.photo_id
    WHERE s.event_id IN (${sql.join(eventIds.map((id) => sql`${id}::uuid`), sql`, `)})
    ORDER BY s.event_id, s.position`)) as unknown as Row[];
  for (const r of rows) {
    const list = map.get(r.event_id) ?? [];
    list.push({
      name: r.name,
      bio: r.bio,
      photo_id: r.photo_id,
      photo_url: r.storage_path ? storage().url(r.storage_path) : null,
    });
    map.set(r.event_id, list);
  }
  return map;
}

export async function getExtraSpeakers(eventId: string): Promise<ExtraSpeaker[]> {
  return (await getExtraSpeakersMap([eventId])).get(eventId) ?? [];
}

// Validates the `extra_speakers` array from a request body. Returns undefined
// when the field wasn't sent (so a PATCH leaves the list alone).
export function parseExtraSpeakers(input: unknown): ExtraSpeaker[] | undefined {
  if (input === undefined) return undefined;
  if (input === null) return [];
  if (!Array.isArray(input)) throw new ApiError(400, "extra_speakers must be a list");
  const out: ExtraSpeaker[] = [];
  for (const s of input) {
    const name = String(s?.name ?? "").trim();
    const bio = String(s?.bio ?? "").trim() || null;
    const photo = String(s?.photo_id ?? "").trim() || null;
    if (!name && !bio && !photo) continue; // empty block — ignore
    if (!name) throw new ApiError(400, "Each extra speaker needs a name");
    if (photo && !UUID.test(photo)) throw new ApiError(400, "Invalid speaker photo");
    out.push({ name: name.slice(0, 200), bio: bio ? bio.slice(0, 4000) : null, photo_id: photo });
  }
  if (out.length > MAX_EXTRA) throw new ApiError(400, `At most ${MAX_EXTRA + 1} speakers per event`);
  return out;
}

export async function setExtraSpeakers(eventId: string, list: ExtraSpeaker[]): Promise<ExtraSpeaker[]> {
  await ensureEventSpeakersTable();
  await db.transaction(async (tx) => {
    await tx.execute(sql`DELETE FROM event_extra_speakers WHERE event_id = ${eventId}::uuid`);
    for (const [i, s] of list.entries()) {
      await tx.execute(sql`
        INSERT INTO event_extra_speakers (event_id, position, name, bio, photo_id)
        VALUES (${eventId}::uuid, ${i}, ${s.name}, ${s.bio}, ${s.photo_id}::uuid)`);
    }
  });
  return getExtraSpeakers(eventId);
}
