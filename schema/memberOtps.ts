import { pgTable, uuid, text, integer, jsonb, timestamp, index } from "drizzle-orm/pg-core";
import { users } from "./identity";

// One-time email codes for registering to events by membership number
// (MRN) without logging in, and for linking an MRN to a logged-in account.
// See server/routes/memberVerify.ts and migration 0107.
//   purpose: 'existing' — MRN already belongs to `user_id`; code went to that user's email
//            'directory' — MRN found only in icai_member_master; code went to its email
//            'new'      — MRN unknown; code went to the email the member typed
//            'link'     — logged-in `linking_user_id` claims the MRN
export const memberOtps = pgTable("member_otps", {
  id:              uuid("id").primaryKey().defaultRandom(),
  purpose:         text("purpose").notNull(),
  mrn:             text("mrn").notNull(),
  email:           text("email").notNull(),
  code_hash:       text("code_hash").notNull(),
  user_id:         uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
  linking_user_id: uuid("linking_user_id").references(() => users.id, { onDelete: "cascade" }),
  pending:         jsonb("pending").notNull().default({}),
  attempts:        integer("attempts").notNull().default(0),
  expires_at:      timestamp("expires_at", { withTimezone: true }).notNull(),
  consumed_at:     timestamp("consumed_at", { withTimezone: true }),
  created_at:      timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  byMrn: index("idx_member_otps_mrn_created").on(t.mrn, t.created_at),
}));
