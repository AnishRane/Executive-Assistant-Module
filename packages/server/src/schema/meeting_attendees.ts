import { pgTable, uuid, text, boolean, timestamp, index } from "drizzle-orm/pg-core";

// One row per external attendee per meeting. Denormalised on purpose
// — the same person across two meetings may have a different title
// or company at each point in time, and the snapshot should reflect
// what was true that day.

export const meetingAttendees = pgTable(
  "executive_assistant__meeting_attendees",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    meetingId: uuid("meeting_id").notNull(),
    email: text("email").notNull(),
    name: text("name"),
    title: text("title"),
    company: text("company"),
    bio: text("bio"),
    isExternal: boolean("is_external").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    meetingIdx: index("ea__meeting_attendees_meeting_idx").on(table.meetingId),
  })
);
