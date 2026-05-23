import { pgTable, uuid, text, jsonb, timestamp } from "drizzle-orm/pg-core";

// v0.4.14 — Structured per-tenant settings. Used for things that
// need exact-key lookup (timezone, home/current location), which the
// framework.memory tool does not support — memory is a semantic
// search store, not a key-value map.
//
// Keys in active use:
//   home_location     → { label, latitude?, longitude?, tz }
//   current_location  → { label, latitude?, longitude?, tz }
//
// Add new keys as needed; the value column is JSONB.

export const userPreferences = pgTable("executive_assistant__user_preferences", {
  tenantId: uuid("tenant_id").notNull(),
  key: text("key").notNull(),
  value: jsonb("value").$type<Record<string, unknown>>().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
