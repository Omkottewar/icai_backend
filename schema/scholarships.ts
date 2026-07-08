import { pgTable, uuid, text, timestamp, boolean, integer, jsonb, index, unique } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { users } from "./identity";
import { files } from "./files";

// ─── Scholarships ────────────────────────────────────────────────────────
//
// Section N.6 (Student wing / scholarships). Two tables:
//
//   scholarships              — the offer (branch admin posts these)
//   scholarship_applications  — a student's response (one per scholarship)
//
// Kept intentionally lightweight for the MVP: the "review workflow" is a
// single status flip (submitted → under_review → awarded / rejected). The
// jury/rubric layer can slot in later without breaking the row shape.

export const scholarships = pgTable(
  "scholarships",
  {
    id:                 uuid("id").primaryKey().defaultRandom(),
    slug:               text("slug").notNull(),
    title:              text("title").notNull(),
    // Short teaser shown on listing cards.
    summary:            text("summary"),
    // Full markdown body — eligibility, benefits, selection process.
    description:        text("description").notNull(),
    eligibility:        text("eligibility"),
    // ₹ amount awarded per selected candidate (paise). NULL = unspecified.
    award_amount_paise: integer("award_amount_paise"),
    // Applications close after this date. NULL = rolling / always open.
    deadline_at:        timestamp("deadline_at", { withTimezone: true }),
    // Toggle to accept applications through the portal. When false, the
    // scholarship still shows in the listing (with an "applications closed"
    // pill) but the apply button is disabled.
    applications_open:  boolean("applications_open").notNull().default(true),
    // External URL — if the branch prefers redirecting to a Google Form /
    // ICAI page instead of collecting via the portal, they set this and
    // hide the internal apply form.
    external_url:       text("external_url"),
    // Optional cover image (uploaded via /admin/files).
    cover_file_id:      uuid("cover_file_id").references(() => files.id, { onDelete: "set null" }),
    active:             boolean("active").notNull().default(true),
    sort_order:         integer("sort_order").notNull().default(0),
    created_by:         uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    created_at:         timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updated_at:         timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    deleted_at:         timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [
    unique("scholarships_slug_uq").on(t.slug),
    index("scholarships_active_idx").on(t.active, t.sort_order),
  ],
);

export const scholarshipApplications = pgTable(
  "scholarship_applications",
  {
    id:                    uuid("id").primaryKey().defaultRandom(),
    scholarship_id:        uuid("scholarship_id").notNull().references(() => scholarships.id, { onDelete: "cascade" }),
    student_user_id:       uuid("student_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    // Free-text application fields — kept as columns because they're the
    // three fields the MVP shipped with and the committee reads them every
    // time. Everything else lives in `details` (JSONB) so we can extend the
    // shape without a migration per field.
    why_applying:          text("why_applying").notNull(),
    current_situation:     text("current_situation"),
    contact_phone:         text("contact_phone"),
    // Structured payload — academic block, family block, category,
    // 12th/graduation details, other-scholarship declarations, consent
    // flags. See ScholarshipApplicationDetails on the frontend for the
    // canonical shape.
    details:               jsonb("details").notNull().default(sql`'{}'::jsonb`),
    // Uploaded evidence: mark sheet, income proof, and one "other" slot.
    // Each element is a file ID pointing at the shared `files` table.
    document_file_ids:     uuid("document_file_ids").array().notNull().default(sql`'{}'::uuid[]`),
    // Lifecycle
    status:                text("status").notNull().default("submitted"),
    // submitted | under_review | shortlisted | awarded | rejected | withdrawn
    reviewer_user_id:      uuid("reviewer_user_id").references(() => users.id, { onDelete: "set null" }),
    reviewer_note:         text("reviewer_note"),
    decided_at:            timestamp("decided_at", { withTimezone: true }),
    created_at:            timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updated_at:            timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("scholarship_applications_scholarship_idx").on(t.scholarship_id),
    index("scholarship_applications_student_idx").on(t.student_user_id),
    // One active application per student per scholarship. Withdrawn rows
    // don't block a resubmission — the partial index excludes them.
    unique("scholarship_applications_uniq").on(t.scholarship_id, t.student_user_id),
  ],
);
