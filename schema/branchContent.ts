import {
  pgTable,
  uuid,
  text,
  integer,
  boolean,
  date,
  timestamp,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { events } from "./events";
import { files } from "./files";

// ─── Branch content tables ─────────────────────────────────────────────────────
//
// These tables back the public-facing Resources / Gallery / About pages.
// Until migration 0030 they lived as hard-coded JS arrays — admin-only files
// like CHECKLIST_UI_MOCKUP.html or constants.js. Now every item has a real
// row, an editor, and a history.
//
// All tables follow the same pattern:
//   - `hidden` flag rather than a soft-delete column (admins want to hide
//     a row without destroying the file metadata)
//   - `sort_order` to allow manual reordering on the public page
//   - separate `pdf_file_id` / `cover_file_id` so the cover image and
//     the downloadable PDF can move independently

export const paperPresentations = pgTable(
  "paper_presentations",
  {
    id:            uuid("id").primaryKey().defaultRandom(),
    title:         text("title").notNull(),
    speaker_name:  text("speaker_name").notNull(),
    committee_tag: text("committee_tag"),                                // GST | DT | IT | Audit | CPE | WICASA | Branch
    event_id:      uuid("event_id").references(() => events.id, { onDelete: "set null" }),
    presented_on:  date("presented_on"),
    pdf_file_id:   uuid("pdf_file_id").references(() => files.id, { onDelete: "set null" }),
    description:   text("description"),
    hidden:        boolean("hidden").notNull().default(false),
    sort_order:    integer("sort_order").notNull().default(0),
    created_at:    timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updated_at:    timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("paper_presentations_committee_idx").on(t.committee_tag),
    index("paper_presentations_presented_idx").on(t.presented_on),
  ],
);

export const galleryAlbums = pgTable(
  "gallery_albums",
  {
    id:            uuid("id").primaryKey().defaultRandom(),
    title:         text("title").notNull(),
    event_id:      uuid("event_id").references(() => events.id, { onDelete: "set null" }),
    committee_tag: text("committee_tag"),
    occurred_on:   date("occurred_on"),
    description:   text("description"),
    cover_file_id: uuid("cover_file_id").references(() => files.id, { onDelete: "set null" }),
    // 'public' | 'members' | 'private' — see migration 0031. The legacy
    // `hidden` flag stays as an editorial "not ready yet" toggle; visibility
    // controls who sees it once published.
    visibility:    text("visibility").notNull().default("public"),
    hidden:        boolean("hidden").notNull().default(false),
    sort_order:    integer("sort_order").notNull().default(0),
    created_at:    timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updated_at:    timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("gallery_albums_committee_idx").on(t.committee_tag),
    index("gallery_albums_occurred_idx").on(t.occurred_on),
  ],
);

export const galleryPhotos = pgTable(
  "gallery_photos",
  {
    id:          uuid("id").primaryKey().defaultRandom(),
    album_id:    uuid("album_id").notNull().references(() => galleryAlbums.id, { onDelete: "cascade" }),
    file_id:     uuid("file_id").notNull().references(() => files.id, { onDelete: "cascade" }),
    caption:     text("caption"),
    sort_order:  integer("sort_order").notNull().default(0),
    created_at:  timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("gallery_photos_album_idx").on(t.album_id, t.sort_order),
  ],
);

export const branchNewsletters = pgTable(
  "branch_newsletters",
  {
    id:            uuid("id").primaryKey().defaultRandom(),
    title:         text("title").notNull(),
    issue_month:   integer("issue_month").notNull(),
    issue_year:    integer("issue_year").notNull(),
    pdf_file_id:   uuid("pdf_file_id").references(() => files.id, { onDelete: "set null" }),
    cover_file_id: uuid("cover_file_id").references(() => files.id, { onDelete: "set null" }),
    editor_note:   text("editor_note"),
    published_at:  timestamp("published_at", { withTimezone: true }),
    hidden:        boolean("hidden").notNull().default(false),
    created_at:    timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updated_at:    timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("branch_newsletters_issue_uq").on(t.issue_year, t.issue_month),
  ],
);

export const officeBearers = pgTable(
  "office_bearers",
  {
    id:            uuid("id").primaryKey().defaultRandom(),
    term_label:    text("term_label").notNull(),                      // "2025-26"
    role_label:    text("role_label").notNull(),                      // "Chairman"
    role_code:     text("role_code"),                                 // 'chairman', etc.
    person_name:   text("person_name").notNull(),
    photo_file_id: uuid("photo_file_id").references(() => files.id, { onDelete: "set null" }),
    bio:           text("bio"),
    email:         text("email"),
    phone:         text("phone"),
    is_current:    boolean("is_current").notNull().default(false),
    tenure_start:  date("tenure_start"),
    tenure_end:    date("tenure_end"),
    sort_order:    integer("sort_order").notNull().default(0),
    hidden:        boolean("hidden").notNull().default(false),
    created_at:    timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updated_at:    timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("office_bearers_term_idx").on(t.term_label),
    index("office_bearers_role_idx").on(t.role_code),
  ],
);

export const annualReports = pgTable(
  "annual_reports",
  {
    id:            uuid("id").primaryKey().defaultRandom(),
    fy_label:      text("fy_label").notNull(),                        // "2024-25"
    title:         text("title"),
    pdf_file_id:   uuid("pdf_file_id").references(() => files.id, { onDelete: "set null" }),
    cover_file_id: uuid("cover_file_id").references(() => files.id, { onDelete: "set null" }),
    summary:       text("summary"),
    published_at:  timestamp("published_at", { withTimezone: true }),
    hidden:        boolean("hidden").notNull().default(false),
    created_at:    timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updated_at:    timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("annual_reports_fy_uq").on(t.fy_label),
  ],
);
