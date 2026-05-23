import { pgTable, uuid, text, timestamp, jsonb, index } from "drizzle-orm/pg-core";

// David's signals from the dossier surface. Captured by domain tools
// when the call is user-initiated (ctx.agentId is null/absent).
//
// Polymorphic subject: (subject_kind, subject_id). Not FK-enforced —
// subjects span tables (meetings, trip_legs, snapshots, deltas,
// action_items, conflicts, attendees). The application is the
// authority; the DB is the audit log.
//
// signal_kind enum is closed at the application layer (Zod) but
// stored as text here so adding a new kind doesn't require a schema
// migration.

export const feedbackSignals = pgTable(
  "executive_assistant__feedback_signals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    signalKind: text("signal_kind").notNull(),
    subjectKind: text("subject_kind").notNull(),
    subjectId: uuid("subject_id").notNull(),
    value: jsonb("value").$type<Record<string, unknown>>().notNull().default({}),
    createdByUserId: uuid("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    tenantIdx: index("ea__feedback_signals_tenant_idx").on(table.tenantId, table.createdAt),
    subjectIdx: index("ea__feedback_signals_subject_idx").on(table.subjectKind, table.subjectId),
    kindIdx: index("ea__feedback_signals_kind_idx").on(table.tenantId, table.signalKind),
  }),
);
