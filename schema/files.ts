import { pgTable, uuid, text, integer, timestamp, AnyPgColumn } from "drizzle-orm/pg-core";
import { users } from "./identity";

// ─── Files ───────────────────────────────────────────────────────────────────
// Metadata for every upload — banners, certificates, KYM documents, etc.
// The actual bytes live on Supabase Storage (or local /uploads in dev); this
// table only stores the bucket + object path so the application can build
// signed URLs.
//
// FKs into this table (set on the referencing column with onDelete: "set null"):
//   • users.avatar_id
//   • events.banner_id
//   • cpe_credits.certificate_file_id
//
// The users.id reference below uses AnyPgColumn to break the
// files ↔ users circular import (files.uploaded_by → users,
// users.avatar_id → files). TS needs an explicit hint to resolve the cycle.

export const files = pgTable("files", {
  id:           uuid("id").primaryKey().defaultRandom(),
  name:         text("name").notNull(),                           // original filename
  mime_type:    text("mime_type").notNull(),
  size_bytes:   integer("size_bytes").notNull(),
  storage_path: text("storage_path").notNull(),                   // path within the bucket (the original)
  bucket:       text("bucket").notNull(),                         // avatars / banners / certificates
  // Image variants — populated by the sharp pipeline at upload time for
  // image MIME types. NULL for PDFs and other non-image files. Storing
  // variant paths (rather than computing them on-the-fly from the original)
  // means we can move to object storage later without touching any caller.
  thumb_path:   text("thumb_path"),                               // ~240px wide WebP — grid tiles
  medium_path:  text("medium_path"),                              // ~800px wide WebP — lightbox
  width:        integer("width"),                                  // pixels of the original
  height:       integer("height"),
  // Required for any image used in the public gallery. Optional for other
  // uses (banners, certificates) — the gallery admin enforces presence.
  alt_text:     text("alt_text"),
  uploaded_by:  uuid("uploaded_by").references((): AnyPgColumn => users.id, { onDelete: "set null" }),
  created_at:   timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  deleted_at:   timestamp("deleted_at", { withTimezone: true }),
});
