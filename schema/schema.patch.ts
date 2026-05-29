/**
 * schema.patch.ts
 *
 * Fixes identified in the PK/FK audit:
 *  1. Missing `files` table  (used by users.avatar_id, events.banner_id, cpe_credits.certificate_file_id)
 *  2. Missing `committees` table  (used by events.committee_id — NOT NULL)
 *  3. Missing `rooms` table  (used by room_bookings.room_id — NOT NULL)
 *  4. Missing FK: consultations.counselor_id → users.id
 *  5. Missing FK: events.recurrence_parent_id → events.id  (self-ref)
 *  6. Missing FK: users.avatar_id → files.id
 *  7. Missing FK: events.banner_id → files.id
 *  8. Missing FK: cpe_credits.certificate_file_id → files.id
 *  9. Missing FK: room_bookings.room_id → rooms.id
 * 10. articleship_status promoted from plain text → enum + CHECK enforced via Drizzle enum
 *
 * HOW TO USE
 * ----------
 * 1. Add these exports to your existing schema barrel (e.g. src/db/schema/index.ts).
 * 2. Patch your existing table definitions with the .references() calls shown at the bottom
 *    (search for "PATCH EXISTING TABLE" comments).
 * 3. Run:  npx drizzle-kit generate  →  npx drizzle-kit migrate
 */

import {
  pgTable,
  pgEnum,
  uuid,
  text,
  boolean,
  integer,
  timestamp,
} from "drizzle-orm/pg-core";

// ─── Re-export your existing tables so the FKs below can reference them ───────
// Adjust these import paths to wherever your existing schema files live.
import { users } from "./identity";
import { events } from "./events";
import { payments } from "./payments";

// ═══════════════════════════════════════════════════════════════════════════════
// FIX 10 — articleship_status enum
// ═══════════════════════════════════════════════════════════════════════════════
// Replace the plain `text` column in student_profiles with this enum.
// Add or adjust values to match your actual business domain.
export const articleshipStatusEnum = pgEnum("articleship_status", [
  "not_started",
  "ongoing",
  "completed",
  "terminated",
]);

// ═══════════════════════════════════════════════════════════════════════════════
// FIX 1 — files table
// Covers: users.avatar_id, events.banner_id, cpe_credits.certificate_file_id
// ═══════════════════════════════════════════════════════════════════════════════
export const files = pgTable("files", {
  id: uuid("id").primaryKey().defaultRandom(),

  /** Original filename as uploaded by the user. */
  name: text("name").notNull(),

  /** MIME type, e.g. "image/jpeg", "application/pdf". */
  mimeType: text("mime_type").notNull(),

  /** File size in bytes. */
  sizeBytes: integer("size_bytes").notNull(),

  /**
   * Storage path / key within your bucket.
   * For Supabase Storage this is the object path, e.g. "avatars/user-id/photo.jpg".
   */
  storagePath: text("storage_path").notNull(),

  /** Supabase Storage bucket name, e.g. "avatars", "banners", "certificates". */
  bucket: text("bucket").notNull(),

  /** User who uploaded the file (nullable for system-generated files). */
  uploadedBy: uuid("uploaded_by").references(() => users.id, {
    onDelete: "set null",
  }),

  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),

  deletedAt: timestamp("deleted_at", { withTimezone: true }),
});

// ═══════════════════════════════════════════════════════════════════════════════
// FIX 2 — committees table
// events.committee_id is NOT NULL — this table must exist before events can insert.
// ═══════════════════════════════════════════════════════════════════════════════
export const committees = pgTable("committees", {
  id: uuid("id").primaryKey().defaultRandom(),

  /** Short code, e.g. "CPE", "EXAM", "MEMBERSHIP". */
  code: text("code").notNull().unique(),

  name: text("name").notNull(),
  description: text("description"),
  active: boolean("active").notNull().default(true),

  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// ═══════════════════════════════════════════════════════════════════════════════
// FIX 3 — rooms table
// room_bookings.room_id is NOT NULL — this table must exist.
// ═══════════════════════════════════════════════════════════════════════════════
export const rooms = pgTable("rooms", {
  id: uuid("id").primaryKey().defaultRandom(),

  name: text("name").notNull(),

  /** Location / floor / building description. */
  location: text("location"),

  /** Maximum seating capacity. */
  capacity: integer("capacity"),

  /** Hourly rate in paise (0 = free). */
  feePaisePerHour: integer("fee_paise_per_hour").notNull().default(0),

  active: boolean("active").notNull().default(true),

  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// ═══════════════════════════════════════════════════════════════════════════════
// PATCH EXISTING TABLES
// ─────────────────────────────────────────────────────────────────────────────
// Drizzle does NOT support mutating an already-exported table object, so you
// need to edit the original table definition in your existing schema files.
// Copy the relevant .references() call into each table below.
// ═══════════════════════════════════════════════════════════════════════════════

/*
 ┌─────────────────────────────────────────────────────────────────────────────┐
 │ FIX 4 — consultations.counselor_id → users(id)                             │
 │                                                                             │
 │ In your existing consultations table definition, change:                    │
 │                                                                             │
 │   counselorId: uuid("counselor_id").notNull(),                              │
 │                                                                             │
 │ to:                                                                         │
 │                                                                             │
 │   counselorId: uuid("counselor_id")                                         │
 │     .notNull()                                                              │
 │     .references(() => users.id, { onDelete: "restrict" }),                 │
 └─────────────────────────────────────────────────────────────────────────────┘

 ┌─────────────────────────────────────────────────────────────────────────────┐
 │ FIX 5 — events.recurrence_parent_id → events(id)  (self-reference)        │
 │                                                                             │
 │ In your existing events table definition, change:                           │
 │                                                                             │
 │   recurrenceParentId: uuid("recurrence_parent_id"),                         │
 │                                                                             │
 │ to:                                                                         │
 │                                                                             │
 │   recurrenceParentId: uuid("recurrence_parent_id")                          │
 │     .references((): AnyPgColumn => events.id, { onDelete: "set null" }),   │
 │                                                                             │
 │ Also add this import at the top of your events schema file:                 │
 │   import type { AnyPgColumn } from "drizzle-orm/pg-core";                  │
 └─────────────────────────────────────────────────────────────────────────────┘

 ┌─────────────────────────────────────────────────────────────────────────────┐
 │ FIX 6 — users.avatar_id → files(id)                                        │
 │                                                                             │
 │ In your existing users table definition, change:                            │
 │                                                                             │
 │   avatarId: uuid("avatar_id"),                                              │
 │                                                                             │
 │ to:                                                                         │
 │                                                                             │
 │   avatarId: uuid("avatar_id")                                               │
 │     .references(() => files.id, { onDelete: "set null" }),                 │
 └─────────────────────────────────────────────────────────────────────────────┘

 ┌─────────────────────────────────────────────────────────────────────────────┐
 │ FIX 7 — events.banner_id → files(id)                                       │
 │                                                                             │
 │ In your existing events table definition, change:                           │
 │                                                                             │
 │   bannerId: uuid("banner_id"),                                              │
 │                                                                             │
 │ to:                                                                         │
 │                                                                             │
 │   bannerId: uuid("banner_id")                                               │
 │     .references(() => files.id, { onDelete: "set null" }),                 │
 └─────────────────────────────────────────────────────────────────────────────┘

 ┌─────────────────────────────────────────────────────────────────────────────┐
 │ FIX 8 — cpe_credits.certificate_file_id → files(id)                        │
 │                                                                             │
 │ In your existing cpe_credits table definition, change:                      │
 │                                                                             │
 │   certificateFileId: uuid("certificate_file_id"),                           │
 │                                                                             │
 │ to:                                                                         │
 │                                                                             │
 │   certificateFileId: uuid("certificate_file_id")                            │
 │     .references(() => files.id, { onDelete: "set null" }),                 │
 └─────────────────────────────────────────────────────────────────────────────┘

 ┌─────────────────────────────────────────────────────────────────────────────┐
 │ FIX 9 — room_bookings.room_id → rooms(id)                                  │
 │                                                                             │
 │ In your existing room_bookings table definition, change:                    │
 │                                                                             │
 │   roomId: uuid("room_id").notNull(),                                        │
 │                                                                             │
 │ to:                                                                         │
 │                                                                             │
 │   roomId: uuid("room_id")                                                   │
 │     .notNull()                                                              │
 │     .references(() => rooms.id, { onDelete: "restrict" }),                 │
 └─────────────────────────────────────────────────────────────────────────────┘

 ┌─────────────────────────────────────────────────────────────────────────────┐
 │ FIX 10 — student_profiles.articleship_status → enum                        │
 │                                                                             │
 │ In your existing student_profiles table definition, change:                 │
 │                                                                             │
 │   articleshipStatus: text("articleship_status"),                            │
 │                                                                             │
 │ to:                                                                         │
 │                                                                             │
 │   articleshipStatus: articleshipStatusEnum("articleship_status"),           │
 │                                                                             │
 │ And import articleshipStatusEnum from this file.                            │
 │                                                                             │
 │ NOTE: before running the migration, manually update any existing rows       │
 │ in student_profiles to use one of the valid enum values, otherwise          │
 │ the ALTER COLUMN will fail with a cast error.                               │
 └─────────────────────────────────────────────────────────────────────────────┘

 ┌─────────────────────────────────────────────────────────────────────────────┐
 │ FIX 2 — events.committee_id → committees(id)                               │
 │                                                                             │
 │ In your existing events table definition, change:                           │
 │                                                                             │
 │   committeeId: uuid("committee_id").notNull(),                              │
 │                                                                             │
 │ to:                                                                         │
 │                                                                             │
 │   committeeId: uuid("committee_id")                                         │
 │     .notNull()                                                              │
 │     .references(() => committees.id, { onDelete: "restrict" }),            │
 └─────────────────────────────────────────────────────────────────────────────┘
*/