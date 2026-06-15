import { pgTable, uuid, text, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { users } from "./identity";

// ─── Push Subscriptions ──────────────────────────────────────────────────────
// One row per (user, device). When a user enables push on a device, the
// browser's PushManager hands us an endpoint + p256dh + auth keypair which
// we store here and replay against from notify.ts.
//
// A single user can have many active subscriptions — e.g. desktop Chrome +
// their phone PWA — and each receives the same notification independently.
//
// Stale subscriptions (410 Gone / 404 from the push service) are pruned on
// the failing send, so this table self-cleans without a cron.

export const pushSubscriptions = pgTable(
  "push_subscriptions",
  {
    id:           uuid("id").primaryKey().defaultRandom(),
    user_id:      uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    endpoint:     text("endpoint").notNull(),
    p256dh:       text("p256dh").notNull(),
    auth:         text("auth").notNull(),
    user_agent:   text("user_agent"),
    created_at:   timestamp("created_at",   { withTimezone: true }).notNull().defaultNow(),
    last_seen_at: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Look-up by user is the hot path (notify.ts iterates user → devices).
    index("push_subscriptions_user_idx").on(t.user_id),
    // The endpoint URL itself is globally unique — two browsers will never
    // hand out the same one. Treat it as the natural key so re-subscribing
    // from the same device just refreshes the row instead of duplicating it.
    uniqueIndex("push_subscriptions_endpoint_uq").on(t.endpoint),
  ],
);
