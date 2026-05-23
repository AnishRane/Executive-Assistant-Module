import { pgTable, uuid, text, timestamp, date, index } from "drizzle-orm/pg-core";

// One row per day — the frozen morning dossier.
// (tenant_id, snapshot_date) uniqueness enforced in migrations.

export const snapshots = pgTable(
  "executive_assistant__snapshots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    snapshotDate: date("snapshot_date").notNull(),
    generatedAt: timestamp("generated_at", { withTimezone: true }).notNull().defaultNow(),
    narrativeBrief: text("narrative_brief"),
    status: text("status").notNull().default("composed"),
    /**
     * SHA-256 of the deterministic compose-input state (meetings,
     * deltas, conflicts, OOO, weather). Used by
     * `compose.maybe_create_task` to skip the LLM wake when state
     * hasn't shifted since the prior snapshot. Nullable — pre-0.4.0
     * snapshots have no hash and the gate falls back to "recompose".
     */
    stateHash: text("state_hash"),
  },
  (table) => ({
    tenantIdx: index("ea__snapshots_tenant_idx").on(table.tenantId),
  })
);
