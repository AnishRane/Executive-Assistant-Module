import { pgTable, uuid, text, jsonb, timestamp, index } from "drizzle-orm/pg-core";

// One segment of a trip — flight, hotel, or ground transport.
// Built from a stream of emails. current_state holds the latest
// reconciled truth (free shape per kind); source_message_ids holds
// every Gmail Message-ID that contributed, for audit + dedup.

export const tripLegs = pgTable(
  "executive_assistant__trip_legs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tripId: uuid("trip_id").notNull(),
    kind: text("kind").notNull(),
    confirmationCode: text("confirmation_code"),
    provider: text("provider"),
    startsAt: timestamp("starts_at", { withTimezone: true }),
    endsAt: timestamp("ends_at", { withTimezone: true }),
    originLocation: text("origin_location"),
    destinationLocation: text("destination_location"),
    currentState: jsonb("current_state").$type<Record<string, unknown>>().notNull().default({}),
    sourceMessageIds: jsonb("source_message_ids").$type<string[]>().notNull().default([]),
    lastReconciledAt: timestamp("last_reconciled_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    tripIdx: index("ea__trip_legs_trip_idx").on(table.tripId),
    startsIdx: index("ea__trip_legs_starts_idx").on(table.startsAt),
  })
);
