import { pgTable, uuid, text, timestamp, index, boolean } from "drizzle-orm/pg-core";

// A calendar event the agent cares about. Survives across days so
// repeat attendees can be matched to a stable row.
// (tenant_id, google_event_id) uniqueness enforced in migrations —
// drives the upsert on calendar sync.

export const meetings = pgTable(
  "executive_assistant__meetings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    googleEventId: text("google_event_id").notNull(),
    title: text("title").notNull(),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
    location: text("location"),
    conferenceLink: text("conference_link"),
    organizerEmail: text("organizer_email"),
    description: text("description"),
    brief: text("brief"),
    userNotes: text("user_notes"),
    gmailThreadId: text("gmail_thread_id"),
    lastChangeAt: timestamp("last_change_at", { withTimezone: true }),
    // v0.4.28 — categorization. kind ∈ {meeting, event, task, untagged}.
    // kind_locked = user manually overrode; classifier must skip locked rows.
    kind: text("kind").notNull().default("untagged"),
    kindLocked: boolean("kind_locked").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    tenantIdx: index("ea__meetings_tenant_idx").on(table.tenantId),
    startsAtIdx: index("ea__meetings_starts_idx").on(table.tenantId, table.startsAt),
    threadIdx: index("ea__meetings_thread_idx").on(table.tenantId, table.gmailThreadId),
    kindIdx: index("ea__meetings_kind_idx").on(table.tenantId, table.kind),
  })
);
