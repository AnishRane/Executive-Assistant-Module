import { pgTable, uuid, text, timestamp, index } from "drizzle-orm/pg-core";

// The audit log of which emails the agent has read. Anything not in
// this table has, by construction, never been touched by EA.
// (tenant_id, gmail_message_id) uniqueness enforced in migrations.
// bound_entity_id is polymorphic — discriminator is bound_entity_kind.

export const emailAnchors = pgTable(
  "executive_assistant__email_anchors",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    gmailMessageId: text("gmail_message_id").notNull(),
    gmailThreadId: text("gmail_thread_id"),
    anchorKind: text("anchor_kind").notNull(),
    boundEntityKind: text("bound_entity_kind").notNull(),
    boundEntityId: uuid("bound_entity_id").notNull(),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    tenantIdx: index("ea__email_anchors_tenant_idx").on(table.tenantId),
    boundIdx: index("ea__email_anchors_entity_idx").on(table.boundEntityKind, table.boundEntityId),
    threadIdx: index("ea__email_anchors_thread_idx").on(table.tenantId, table.gmailThreadId),
  })
);
