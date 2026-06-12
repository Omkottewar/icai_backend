import { pgTable, uuid, text, timestamp, jsonb, index } from "drizzle-orm/pg-core";
import { users } from "./identity";
import { events } from "./events";

// ─── Event Override Log ─────────────────────────────────────────────────────
// Audit trail for chairman/VC overrides on /events/:id/publish — i.e. when
// they publish an event whose attached checklist isn't fully approved.
//
// The happy path (full checklist approval → auto-publish trigger) leaves
// nothing here. Only override events appear in this table. The chairman's
// approval log on a publish has to be discoverable for compliance.
//
// `checklist_state` is a JSON snapshot of the approval stages at the moment
// of override, e.g. { branch_chairman: 'approved', treasurer_iut: 'pending',
// vc_agenda: 'pending' }. This is denormalised on purpose — if stages later
// flip, the snapshot stays frozen at override-time.

export const eventOverrideLog = pgTable(
  "event_override_log",
  {
    id:               uuid("id").primaryKey().defaultRandom(),
    event_id:         uuid("event_id").notNull().references(() => events.id, { onDelete: "cascade" }),
    actor_id:         uuid("actor_id").references(() => users.id, { onDelete: "set null" }),
    acted_at:         timestamp("acted_at", { withTimezone: true }).notNull().defaultNow(),
    reason:           text("reason"),
    checklist_state:  jsonb("checklist_state").notNull().default({}),
  },
  (t) => [
    index("event_override_log_event_idx").on(t.event_id),
    index("event_override_log_actor_idx").on(t.actor_id),
  ],
);
