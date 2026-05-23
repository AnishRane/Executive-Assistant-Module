import { pgTable, uuid, text, timestamp, jsonb, index } from "drizzle-orm/pg-core";

// Changes detected since the morning snapshot. Drives the
// "changed since you last looked" UI signals (badges, delta
// strips). DESIGN.md §4 / §8.
//
// meta carries the structured prior values (e.g. fromStartsAt,
// toStartsAt) so the UI can render precise "was X, now Y" text
// without parsing the summary string.

export const deltas = pgTable(
  "executive_assistant__deltas",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    snapshotId: uuid("snapshot_id").notNull(),
    timelineItemId: uuid("timeline_item_id").notNull(),
    deltaKind: text("delta_kind").notNull(),
    summary: text("summary"),
    meta: jsonb("meta").$type<Record<string, unknown>>().notNull().default({}),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
    acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
  },
  (table) => ({
    snapshotIdx: index("ea__deltas_snapshot_idx").on(table.snapshotId, table.occurredAt),
    itemIdx: index("ea__deltas_item_idx").on(table.timelineItemId),
  }),
);
