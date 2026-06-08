import {
  pgTable, uuid, text, jsonb, timestamp, index, boolean,
} from "drizzle-orm/pg-core";
import { users } from "./identity";

// ─── Notification Templates ───────────────────────────────────────────────────
// Editable copy for each S.* notification key (event_registered, event_reminder,
// room_booking_confirmed, etc.). The admin UI exposes these so the branch can
// tune wording without code changes. `channels` lists which delivery channels
// this template is enabled for — currently 'inapp' and 'email'; SMS / WhatsApp
// columns are reserved for later but not yet wired.
//
// `{{var}}` placeholders in subject / body are substituted at dispatch time
// from the `vars` object passed to notify(). See server/lib/notify.ts.

export const notificationTemplates = pgTable("notification_templates", {
  key:           text("key").primaryKey(),
  name:          text("name").notNull(),
  description:   text("description"),
  channels:      text("channels").array().notNull().default(["inapp", "email"]),
  email_subject: text("email_subject"),
  email_body:    text("email_body"),
  inapp_title:   text("inapp_title"),
  inapp_body:    text("inapp_body"),
  enabled:       boolean("enabled").notNull().default(true),
  updated_by:    uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
  updated_at:    timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ─── Notifications ────────────────────────────────────────────────────────────
// One row per (user, event) — the in-app inbox. The template key is denormalised
// in `template_key` but the final rendered copy is stored on the row so the
// inbox stays readable even if a template is later edited or deleted.

export const notifications = pgTable(
  "notifications",
  {
    id:           uuid("id").primaryKey().defaultRandom(),
    user_id:      uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    template_key: text("template_key").references(() => notificationTemplates.key, { onDelete: "set null" }),
    title:        text("title").notNull(),
    body:         text("body"),
    link_url:     text("link_url"),
    metadata:     jsonb("metadata").notNull().default({}),
    read_at:      timestamp("read_at", { withTimezone: true }),
    created_at:   timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // The inbox query is "this user's notifications, newest first". A composite
    // index on (user_id, created_at DESC) lets the planner answer it with one
    // scan and no sort.
    //
    // A separate partial index on (user_id) WHERE read_at IS NULL backs the
    // unread-count badge — defined in the raw migration since drizzle's
    // index() doesn't model partial predicates cleanly. Don't add it here.
    index("notifications_user_idx").on(t.user_id, t.created_at),
  ],
);

// ─── Notification Deliveries ──────────────────────────────────────────────────
// Per-channel send attempt. One notification row can fan out to email + SMS
// + WhatsApp — each fan-out is one row here. The audit trail lets admins debug
// "why didn't I get the email" without rummaging through server logs.

export const notificationDeliveries = pgTable(
  "notification_deliveries",
  {
    id:              uuid("id").primaryKey().defaultRandom(),
    notification_id: uuid("notification_id").notNull().references(() => notifications.id, { onDelete: "cascade" }),
    channel:         text("channel").notNull(),     // 'email' | 'sms' | 'whatsapp'
    recipient:       text("recipient").notNull(),   // email address / phone — denormalised for audit
    status:          text("status").notNull().default("queued"), // queued | sent | failed | skipped
    error:           text("error"),
    attempted_at:    timestamp("attempted_at", { withTimezone: true }).notNull().defaultNow(),
    sent_at:         timestamp("sent_at", { withTimezone: true }),
  },
  (t) => [
    index("notification_deliveries_notification_idx").on(t.notification_id),
  ],
);
