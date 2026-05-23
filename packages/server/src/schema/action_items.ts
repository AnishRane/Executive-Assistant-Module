import { pgTable, uuid, text, timestamp, index } from "drizzle-orm/pg-core";

// Open items inferred from a meeting's thread.
// owed_by: 'david' | <external email> — drives how the line is
// phrased on the meeting card. status: open · resolved · ignored
// — David can dismiss false positives, and the dismissal becomes
// a feedback_signal in Phase 5.

export const actionItems = pgTable(
  "executive_assistant__action_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    meetingId: uuid("meeting_id").notNull(),
    owedBy: text("owed_by").notNull(),
    text: text("text").notNull(),
    status: text("status").notNull().default("open"),
    sourceMessageId: text("source_message_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    meetingIdx: index("ea__action_items_meeting_idx").on(table.meetingId),
    statusIdx: index("ea__action_items_status_idx").on(table.meetingId, table.status),
  }),
);
