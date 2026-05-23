import { pgTable, uuid, text, timestamp, integer, date, index } from "drizzle-orm/pg-core";

// v0.4.14 re-key: conflicts are no longer scoped to a snapshot. They
// point directly at meetings / ooo_windows / trip_legs via
// (ref_kind, ref_id) and are namespaced by for_date. Scan runs on
// every calendar-side mutation; no agent compose required.
//
// Pair canonicalisation: ref_a_id < ref_b_id enforced by a CHECK in
// migration 009 so we never get duplicate rows in reversed order.
// resolved_choice (nullable) points at whichever ref_a_id or ref_b_id
// the user chose to take.

export const conflicts = pgTable(
  "executive_assistant__conflicts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    forDate: date("for_date").notNull(),
    refAKind: text("ref_a_kind").notNull(),
    refAId: uuid("ref_a_id").notNull(),
    refBKind: text("ref_b_kind").notNull(),
    refBId: uuid("ref_b_id").notNull(),
    overlapMinutes: integer("overlap_minutes").notNull(),
    detectedAt: timestamp("detected_at", { withTimezone: true }).notNull().defaultNow(),
    resolutionStatus: text("resolution_status").notNull().default("unresolved"),
    resolvedChoice: uuid("resolved_choice"),
  },
  (table) => ({
    tenantDateIdx: index("ea__conflicts_tenant_date_idx").on(table.tenantId, table.forDate),
  }),
);
