import { pgTable, uuid, text, timestamp, index } from "drizzle-orm/pg-core";

// Verbatim quotes the agent surfaces on a meeting drilldown.
// Stored word-for-word with attribution — verbatim cuts hallucination
// risk on the human-facing surface (DESIGN.md §8 pinned decision).

export const threadExcerpts = pgTable(
  "executive_assistant__thread_excerpts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    meetingId: uuid("meeting_id").notNull(),
    fromName: text("from_name"),
    fromEmail: text("from_email"),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    body: text("body").notNull(),
    sourceMessageId: text("source_message_id"),
    includedInSnapshotId: uuid("included_in_snapshot_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    meetingIdx: index("ea__thread_excerpts_meeting_idx").on(table.meetingId),
    snapshotIdx: index("ea__thread_excerpts_snapshot_idx").on(table.includedInSnapshotId),
  }),
);
