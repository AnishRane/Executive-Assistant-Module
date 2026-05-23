import { pgTable, uuid, text, timestamp, index } from "drizzle-orm/pg-core";

// Out-of-office periods detected from calendar entries marked OOO,
// or from auto-responder emails. source_ref_id holds the Google
// Calendar event id when source = calendar_event, so we can dedup
// on re-sync without inventing a uniqueness constraint that breaks
// the email_autoresponse path.

export const oooWindows = pgTable(
  "executive_assistant__ooo_windows",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
    source: text("source").notNull(),
    sourceRefId: text("source_ref_id"),
    label: text("label"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    tenantIdx: index("ea__ooo_tenant_idx").on(table.tenantId),
    timeIdx: index("ea__ooo_time_idx").on(table.tenantId, table.startsAt, table.endsAt),
  })
);
