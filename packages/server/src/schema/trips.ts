import { pgTable, uuid, text, date, timestamp, index } from "drizzle-orm/pg-core";

// A coherent travel arc grouping multiple legs. The agent infers
// trips from destination and date proximity of inbound trip_legs.

export const trips = pgTable(
  "executive_assistant__trips",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    label: text("label").notNull(),
    origin: text("origin"),
    destination: text("destination"),
    startsOn: date("starts_on"),
    endsOn: date("ends_on"),
    status: text("status").notNull().default("planned"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    tenantIdx: index("ea__trips_tenant_idx").on(table.tenantId),
    datesIdx: index("ea__trips_dates_idx").on(table.tenantId, table.startsOn, table.endsOn),
  })
);
