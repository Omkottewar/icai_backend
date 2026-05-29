import {
  pgTable, uuid, text, integer, timestamp,
} from "drizzle-orm/pg-core";
import { consultationKindEnum, consultationStatusEnum } from "./enums";
import { users } from "./identity";
import { payments } from "./payments";

// ─── Consultations ────────────────────────────────────────────────────────────
// EXCLUDE gist(counselor_id, tstzrange(slot_start, slot_end)) prevents counselor double-booking
// CHECK (slot_end > slot_start) enforced in migration SQL

export const consultations = pgTable("consultations", {
  id:               uuid("id").primaryKey().defaultRandom(),
  counselor_id:     uuid("counselor_id").notNull(),  // FK → counselor_profiles.id
  client_user_id:   uuid("client_user_id").notNull().references(() => users.id),
  kind:             consultationKindEnum("kind").notNull(),
  slot_start:       timestamp("slot_start", { withTimezone: true }).notNull(),
  slot_end:         timestamp("slot_end", { withTimezone: true }).notNull(),
  status:           consultationStatusEnum("status").notNull().default("requested"),
  medium:           text("medium").notNull().default("video"),  // video | call | in_person
  notes_encrypted:  text("notes_encrypted"),   // AES-256 app-layer encrypted
  feedback_rating:  integer("feedback_rating"),
  payment_id:       uuid("payment_id").references(() => payments.id, { onDelete: "set null" }),  // Fix #2
  created_at:       timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updated_at:       timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ─── CABF Assistance Requests ─────────────────────────────────────────────────

export const cabfAssistanceRequests = pgTable("cabf_assistance_requests", {
  id:                        uuid("id").primaryKey().defaultRandom(),
  member_user_id:            uuid("member_user_id").notNull().references(() => users.id),
  category:                  text("category").notNull(),
  amount_requested_paise:    integer("amount_requested_paise").notNull(),
  status:                    text("status").notNull().default("submitted"),
  // submitted / reviewing / approved / rejected / disbursed
  reviewer_user_id:          uuid("reviewer_user_id").references(() => users.id),
  decision_note:             text("decision_note"),
  disbursed_amount_paise:    integer("disbursed_amount_paise"),
  disbursed_at:              timestamp("disbursed_at", { withTimezone: true }),
  disbursement_payment_id:   uuid("disbursement_payment_id").references(() => payments.id, { onDelete: "set null" }),
  created_at:                timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updated_at:                timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
