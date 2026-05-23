import { pgTable, uuid, text, timestamp, boolean, integer, index } from "drizzle-orm/pg-core";

// One entry on a snapshot's timeline.
// Polymorphic: kind ∈ {meeting, trip_leg, ooo} → ref_id points at
// meetings.id / trip_legs.id / ooo_windows.id respectively. Phase 4
// adds kind = "delta" once the deltas table lands.

export const timelineItems = pgTable(
  "executive_assistant__timeline_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    snapshotId: uuid("snapshot_id").notNull(),
    kind: text("kind").notNull(),
    refId: uuid("ref_id").notNull(),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }),
    elevated: boolean("elevated").notNull().default(false),
    elevationReason: text("elevation_reason"),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    snapshotIdx: index("ea__timeline_snapshot_idx").on(table.snapshotId, table.startsAt),
  })
);
