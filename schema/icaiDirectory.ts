import { pgTable, text, boolean, timestamp, jsonb } from "drizzle-orm/pg-core";

// Mirror of the ICAI master member CSV/XLSX — populated by the admin
// importer at /api/admin/icai-directory/import. Used at signup time to
// gate member-role applications (Open Question #3).

export const icaiMemberMaster = pgTable("icai_member_master", {
  mrn:          text("mrn").primaryKey(),
  name:         text("name").notNull(),
  email:        text("email"),
  phone:        text("phone"),
  city:         text("city"),
  firm_name:    text("firm_name"),
  fca_flag:     boolean("fca_flag").notNull().default(false),
  cop_status:   text("cop_status"),
  imported_at:  timestamp("imported_at", { withTimezone: true }).notNull().defaultNow(),
  source_file:  text("source_file"),
  raw:          jsonb("raw"),
});
