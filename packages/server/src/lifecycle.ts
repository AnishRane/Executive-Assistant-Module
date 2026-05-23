// SPDX-License-Identifier: UNLICENSED
//
// EA Module lifecycle hooks.
//
// onInstall(ctx)   runs AFTER schema migrations create the
//                  executive_assistant__* tables.
// onUninstall(ctx) runs BEFORE the down() migrations.
//
// Architecture (post-refactor): EA does no provider-specific parsing.
// Two agents are seeded:
//   1. executive-assistant  — morning composer, wakes on 06:00 cron
//   2. ea-travel-agent      — travel email reader, wakes on
//                             triage.classified events. Uses its LLM
//                             to decide kind, extract fields, and
//                             call trip_legs.reconcile_from_email.
//                             (Renamed from ea-travel-lens in v0.4.9;
//                             the scrub list keeps the legacy role so
//                             upgrades clean up the old agent row.)
//
// Five workflows seeded:
//   - EA Sync Calendar          — 15 min cron, paused until Google connects
//   - EA Scan Meeting Threads   — 15 min cron, paused until Google connects
//   - EA Compose                — every 15 min, always-fresh (hash-guarded)
//   - EA Weekly Reflection      — Mon 06:30
//   - EA Travel Agent on triage — event-driven (triage.classified)
//                                 (was "EA Travel Lens on triage" pre-v0.4.9)

import { sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type {
  ModuleFactoryDeps,
  ModuleLifecycle,
  ToolContext,
} from "@boringos/module-sdk";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { invoke } from "@boringos/agent";
import type { ToolRegistry } from "@boringos/agent";
import { classify } from "./services/classify.js";

// Scrub list intentionally includes the legacy `ea-travel-lens` role
// so an upgrade from pre-v0.4.9 cleans up the old agent row before
// seeding the renamed one.
const EA_AGENT_ROLES = [
  "executive-assistant",
  "ea-travel-agent",
  "ea-travel-lens", // legacy — renamed in v0.4.9, kept in scrub list for migration
] as const;

const EA_WORKFLOW_NAMES = [
  "EA Sync Calendar",
  "EA Scan Meeting Threads",
  "EA Compose",
  "EA Morning Compose", // legacy name from v0.3.x; kept in scrub list for migration
  "EA Travel Agent on triage",
  "EA Travel Lens on triage", // legacy name pre-v0.4.9; kept in scrub list for migration
  "EA Weekly Reflection",
  "EA Immediate Sync on Connect",
  "EA Classify Pending", // v0.4.31 — LLM tagger trigger
  // Removed in v0.3.0: "EA Activate sync routines on Google connect"
  // (sync routines now start active and fail-soft until Google is
  // connected — the activation workflow had multiple broken block
  // types that prevented it from working anyway).
] as const;

export function createExecutiveAssistantLifecycle(
  factoryDeps: ModuleFactoryDeps,
): ModuleLifecycle {
  const db = factoryDeps.db as PostgresJsDatabase;
  const toolRegistry = (factoryDeps.toolRegistry ?? null) as ToolRegistry | null;

  return {
    async onInstall(ctx) {
      const tenantId = ctx.tenantId;
      await scrubEaSeeds(db, tenantId);

      // v0.4.28 — one-shot kind backfill for any existing meetings
      // rows that landed before the classifier was wired into the
      // sync path. Idempotent: only touches untagged-unlocked rows
      // and only writes when the rule has high confidence.
      try {
        await backfillMeetingKinds(db, tenantId);
      } catch (err) {
        console.warn(
          `[executive-assistant.onInstall] kind backfill failed:`,
          err instanceof Error ? err.message : err,
        );
      }

      const calendarWorkflowId = await seedCalendarWorkflow(db, tenantId);
      const scanWorkflowId = await seedScanMeetingsWorkflow(db, tenantId);
      await seedImmediateSyncWorkflow(db, tenantId);
      // No activation workflow in v0.3.0 — the two sync routines below
      // start `active` and the underlying sync_window tools fail-soft
      // when Google isn't connected yet.

      // Agents + their workflows depend on a runtime + root agent
      // existing on the tenant. Bail gracefully if either is missing
      // — same pattern as hebbs-crm.
      const runtimeId = await fetchClaudeRuntimeId(db, tenantId);
      const rootAgentId = await fetchRootAgentId(db, tenantId);

      let morningWorkflowId: string | null = null;
      let reflectionWorkflowId: string | null = null;
      let classifyPendingWorkflowId: string | null = null;
      let executiveAssistantAgentId: string | null = null;
      let travelAgentId: string | null = null;
      let dayComposerAgentId: string | null = null;
      let meetingBrieferAgentId: string | null = null;

      if (runtimeId && rootAgentId) {
        // v0.4.54 — two specialized agents replace the single
        // executive-assistant for new tenants. Each has tight scope
        // per run, mirroring the proven hebbs-crm/Triage/Replier
        // pattern that drives haiku reliably end-to-end.
        dayComposerAgentId = await seedAgent(
          db,
          tenantId,
          runtimeId,
          rootAgentId,
          "EA Day Composer",
          "ea-day-composer",
        );
        meetingBrieferAgentId = await seedAgent(
          db,
          tenantId,
          runtimeId,
          rootAgentId,
          "EA Meeting Briefer",
          "ea-meeting-briefer",
        );
        // Keep the legacy executive-assistant role around — some
        // workflows (weekly reflection, classify-pending) still wake
        // it. Trim those over time.
        executiveAssistantAgentId = await seedAgent(
          db,
          tenantId,
          runtimeId,
          rootAgentId,
          "Executive Assistant",
          "executive-assistant",
        );
        travelAgentId = await seedAgent(
          db,
          tenantId,
          runtimeId,
          rootAgentId,
          "EA Travel Agent",
          "ea-travel-agent",
        );
        // v0.4.54 — morning compose now assigns to the day-composer.
        morningWorkflowId = await seedComposeWorkflow(
          db,
          tenantId,
          dayComposerAgentId,
        );
        reflectionWorkflowId = await seedWeeklyReflectionWorkflow(
          db,
          tenantId,
          executiveAssistantAgentId,
        );
        await seedTravelAgentWorkflow(db, tenantId, travelAgentId);
        // v0.4.31 — LLM tagger workflow + routine for kind=untagged
        // backlog. Cron-driven so each tick is cheap (count, then
        // skip if zero). The compose.classify_pending tool decides
        // whether to actually wake the agent.
        classifyPendingWorkflowId = await seedClassifyPendingWorkflow(db, tenantId);
      } else {
        console.warn(
          `[executive-assistant.onInstall] Missing runtime or root agent for tenant ${tenantId} — skipping agents and event-driven workflows. Re-install once the tenant has both.`,
        );
      }

      await seedRoutines(
        db,
        tenantId,
        calendarWorkflowId,
        scanWorkflowId,
        morningWorkflowId,
        reflectionWorkflowId,
        classifyPendingWorkflowId,
      );

      // Immediately populate data on install so the tenant doesn't
      // wait up to 15 minutes for the first routine tick.
      // Both calls are fail-soft — calendar returns ok:true with a
      // skipped reason when Google isn't connected yet; compose
      // creates a task that resolves location and fetches weather.
      if (toolRegistry) {
        const toolCtx: ToolContext = { tenantId, invokedBy: "internal" };
        const invokeOpts = { registry: toolRegistry, db: db as unknown as never };

        // Calendar — covers the full current ISO week window (start of
        // week through +7 days). Fail-soft when Google not connected.
        await invoke(
          invokeOpts,
          "executive-assistant.calendar.sync_window",
          { days: 7 },
          toolCtx,
        ).catch((err) => {
          console.warn(
            `[executive-assistant.onInstall] calendar sync failed:`,
            err instanceof Error ? err.message : err,
          );
        });

        // v0.4.46 — install fires the Day Brief only. Today's meeting
        // briefs are composed INLINE inside the Day Brief run (per
        // SKILL.md step 6). Future-meeting briefs are generated lazily
        // when the user opens that meeting's drawer (MeetingDrawer's
        // auto-trigger). No upfront sweep, no per-meeting parallel
        // tasks, no queue pile-up.
        if (executiveAssistantAgentId) {
          // Full day compose — resolves location, fetches weather, writes
          // today's narrative brief, today's meeting briefs (inline),
          // and the snapshot.
          await invoke(
            invokeOpts,
            "executive-assistant.compose.maybe_create_task",
            {},
            toolCtx,
          ).catch((err) => {
            console.warn(
              `[executive-assistant.onInstall] compose kick-off failed:`,
              err instanceof Error ? err.message : err,
            );
          });

          // v0.4.14: one-shot conflict scan immediately after the
          // inline calendar sync above (which populated meetings).
          // Runs directly on the meetings table — no snapshot or
          // timeline_items dependency. Conflicts visible the moment
          // /executive loads after install.
          const todayDate = new Date().toISOString().slice(0, 10);
          try {
            const { recomputeConflictsForDate } = await import(
              "./services/conflict_scan.js"
            );
            await recomputeConflictsForDate(db, tenantId, todayDate);
          } catch (err) {
            console.warn(
              `[executive-assistant.onInstall] conflict scan failed:`,
              err instanceof Error ? err.message : err,
            );
          }
        }
      }
    },

    async onUninstall(ctx) {
      await scrubEaSeeds(db, ctx.tenantId);
    },
  };
}

// ─────────────────────────────────────────────────────────────────
// v0.4.28 — kind backfill
// ─────────────────────────────────────────────────────────────────

// One-shot pass over untagged-unlocked meetings: count external
// attendees, run the rule, write kind on high-confidence outcomes.
// Idempotent — re-running is safe; locked rows are never touched.
async function backfillMeetingKinds(
  db: PostgresJsDatabase,
  tenantId: string,
): Promise<void> {
  type Row = {
    id: string;
    title: string;
    conference_link: string | null;
    location: string | null;
    ext_count: string;
  };
  const result = await db.execute(sql`
    SELECT m.id, m.title, m.conference_link, m.location,
           COALESCE((
             SELECT count(*) FROM executive_assistant__meeting_attendees a
             WHERE a.meeting_id = m.id AND a.is_external = true
           ), 0)::text AS ext_count
    FROM executive_assistant__meetings m
    WHERE m.tenant_id = ${tenantId}
      AND m.kind = 'untagged'
      AND m.kind_locked = false
  `);
  const rows = result as unknown as Row[];
  for (const row of rows) {
    const { kind, confidence } = classify({
      title: row.title,
      conferenceLink: row.conference_link,
      location: row.location,
      hasExternalAttendees: Number(row.ext_count) > 0,
    });
    if (confidence === "high") {
      await db.execute(sql`
        UPDATE executive_assistant__meetings
        SET kind = ${kind}
        WHERE id = ${row.id} AND kind_locked = false
      `);
    }
  }
}

// ─────────────────────────────────────────────────────────────────
// Scrub
// ─────────────────────────────────────────────────────────────────

async function scrubEaSeeds(db: PostgresJsDatabase, tenantId: string) {
  const namesIn = sql.join(
    EA_WORKFLOW_NAMES.map((n) => sql`${n}`),
    sql`, `,
  );
  const rolesIn = sql.join(
    EA_AGENT_ROLES.map((r) => sql`${r}`),
    sql`, `,
  );

  await db.execute(sql`
    DELETE FROM routines
    WHERE tenant_id = ${tenantId}
      AND (
        workflow_id IN (
          SELECT id FROM workflows
          WHERE tenant_id = ${tenantId} AND name IN (${namesIn})
        )
        OR assignee_agent_id IN (
          SELECT id FROM agents
          WHERE tenant_id = ${tenantId} AND role IN (${rolesIn})
        )
      )
  `);

  await db.execute(sql`
    DELETE FROM workflow_runs
    WHERE workflow_id IN (
      SELECT id FROM workflows
      WHERE tenant_id = ${tenantId} AND name IN (${namesIn})
    )
  `);

  await db.execute(sql`
    DELETE FROM workflows
    WHERE tenant_id = ${tenantId} AND name IN (${namesIn})
  `);

  await db.execute(sql`
    DELETE FROM cost_events
    WHERE run_id IN (
      SELECT id FROM agent_runs
      WHERE agent_id IN (
        SELECT id FROM agents
        WHERE tenant_id = ${tenantId} AND role IN (${rolesIn})
      )
    )
  `);
  await db.execute(sql`
    DELETE FROM agent_runs
    WHERE agent_id IN (
      SELECT id FROM agents
      WHERE tenant_id = ${tenantId} AND role IN (${rolesIn})
    )
  `);
  await db.execute(sql`
    DELETE FROM agent_wakeup_requests
    WHERE agent_id IN (
      SELECT id FROM agents
      WHERE tenant_id = ${tenantId} AND role IN (${rolesIn})
    )
  `);
  await db.execute(sql`
    UPDATE tasks SET assignee_agent_id = NULL
    WHERE assignee_agent_id IN (
      SELECT id FROM agents
      WHERE tenant_id = ${tenantId} AND role IN (${rolesIn})
    )
  `);
  await db.execute(sql`
    UPDATE tasks SET created_by_agent_id = NULL
    WHERE created_by_agent_id IN (
      SELECT id FROM agents
      WHERE tenant_id = ${tenantId} AND role IN (${rolesIn})
    )
  `);
  await db.execute(sql`
    DELETE FROM agents
    WHERE tenant_id = ${tenantId} AND role IN (${rolesIn})
  `);
}

// ─────────────────────────────────────────────────────────────────
// Runtime + root agent lookup
// ─────────────────────────────────────────────────────────────────

async function fetchClaudeRuntimeId(
  db: PostgresJsDatabase,
  tenantId: string,
): Promise<string | null> {
  const result = await db.execute(sql`
    SELECT id FROM runtimes
    WHERE tenant_id = ${tenantId} AND type = 'claude'
    LIMIT 1
  `);
  const row = (result as unknown as Array<{ id: string }>)[0];
  return row?.id ?? null;
}

async function fetchRootAgentId(
  db: PostgresJsDatabase,
  tenantId: string,
): Promise<string | null> {
  const result = await db.execute(sql`
    SELECT id FROM agents
    WHERE tenant_id = ${tenantId} AND reports_to IS NULL
    ORDER BY created_at ASC
    LIMIT 1
  `);
  const row = (result as unknown as Array<{ id: string }>)[0];
  return row?.id ?? null;
}

// ─────────────────────────────────────────────────────────────────
// Agent seed
// ─────────────────────────────────────────────────────────────────

async function seedAgent(
  db: PostgresJsDatabase,
  tenantId: string,
  runtimeId: string,
  rootAgentId: string,
  name: string,
  role: string,
): Promise<string> {
  const agentId = randomUUID();
  await db.execute(sql`
    INSERT INTO agents (id, tenant_id, name, role, status, instructions, runtime_id, reports_to, created_at, updated_at)
    VALUES (${agentId}, ${tenantId}, ${name}, ${role}, 'idle', '', ${runtimeId}, ${rootAgentId}, now(), now())
  `);
  return agentId;
}

// ─────────────────────────────────────────────────────────────────
// Workflow seeds
// ─────────────────────────────────────────────────────────────────

// v0.3.0 refactor: both sync workflows collapsed to a single tool
// block calling EA-internal sync tools. The previous multi-block
// `connector-action` + `for-each` shape relied on block kinds the
// runner doesn't implement; the tool does the fetch + upsert
// end-to-end, with fail-soft handling when Google isn't connected.

async function seedCalendarWorkflow(
  db: PostgresJsDatabase,
  tenantId: string,
): Promise<string> {
  const id = randomUUID();
  const blocks = [
    {
      id: "trigger",
      name: "trigger",
      kind: "trigger",
      type: "trigger",
      config: {},
    },
    {
      id: "sync",
      name: "sync",
      kind: "tool",
      type: "tool",
      tool: "executive-assistant.calendar.sync_window",
      inputs: { days: 14 },
      config: {},
    },
  ];
  const edges = [
    { id: "e1", sourceBlockId: "trigger", targetBlockId: "sync", sourceHandle: null, sortOrder: 0 },
  ];
  await insertWorkflow(db, tenantId, id, "EA Sync Calendar", blocks, edges);
  return id;
}

// Bulk meeting-thread anchoring. Deterministic — no LLM. Travel
// emails are handled by the ea-travel-agent via the triage event
// path, not by this workflow.
async function seedScanMeetingsWorkflow(
  db: PostgresJsDatabase,
  tenantId: string,
): Promise<string> {
  const id = randomUUID();
  const blocks = [
    {
      id: "trigger",
      name: "trigger",
      kind: "trigger",
      type: "trigger",
      config: {},
    },
    {
      id: "scan",
      name: "scan",
      kind: "tool",
      type: "tool",
      tool: "executive-assistant.email_anchors.scan_window",
      inputs: { maxResults: 100 },
      config: {},
    },
  ];
  const edges = [
    { id: "e1", sourceBlockId: "trigger", targetBlockId: "scan", sourceHandle: null, sortOrder: 0 },
  ];
  await insertWorkflow(db, tenantId, id, "EA Scan Meeting Threads", blocks, edges);
  return id;
}

// Fired immediately when any connector completes OAuth. The sync tools
// fail-soft when Google isn't the one that connected, so this is safe
// to trigger on every connector.connected event. Uses a wider 14-day
// window so the full week strip populates on first connect.
async function seedImmediateSyncWorkflow(
  db: PostgresJsDatabase,
  tenantId: string,
): Promise<string> {
  const id = randomUUID();
  const blocks = [
    {
      id: "trigger",
      name: "trigger",
      kind: "trigger",
      type: "trigger",
      config: { eventType: "connector.connected" },
    },
    {
      id: "sync",
      name: "sync",
      kind: "tool",
      type: "tool",
      tool: "executive-assistant.calendar.sync_window",
      inputs: { days: 14 },
      config: {},
    },
    {
      id: "scan",
      name: "scan",
      kind: "tool",
      type: "tool",
      tool: "executive-assistant.email_anchors.scan_window",
      inputs: { maxResults: 100 },
      config: {},
    },
  ];
  const edges = [
    { id: "e1", sourceBlockId: "trigger", targetBlockId: "sync", sourceHandle: null, sortOrder: 0 },
    { id: "e2", sourceBlockId: "sync", targetBlockId: "scan", sourceHandle: null, sortOrder: 0 },
  ];
  await insertWorkflow(db, tenantId, id, "EA Immediate Sync on Connect", blocks, edges);
  return id;
}

// Phase E (v0.4.0): replaced the 06:00-only "EA Morning Compose"
// workflow with the always-fresh hash-guarded variant. Workflow fires
// every 15 min; the maybe_create_task tool internally compares the
// current compose-state hash to the latest snapshot's stored hash
// and only creates a task (waking the agent) when state has shifted.
//
// agentId param remains unused at the workflow level — the
// maybe_create_task tool looks up the agent from agents.role server-
// side. We keep the param for caller symmetry with v0.3.x scrub +
// re-seed semantics.
async function seedComposeWorkflow(
  db: PostgresJsDatabase,
  tenantId: string,
  _agentId: string,
): Promise<string> {
  const id = randomUUID();
  const blocks = [
    { id: "trigger", name: "trigger", kind: "trigger", type: "trigger", config: {} },
    {
      id: "maybe_compose",
      name: "maybe_compose",
      kind: "tool",
      type: "tool",
      tool: "executive-assistant.compose.maybe_create_task",
      // No inputs — the tool defaults forDate to "today" in the
      // host's timezone, which is what we want for the cron path.
      inputs: {},
      config: {},
    },
  ];
  const edges = [
    { id: "e1", sourceBlockId: "trigger", targetBlockId: "maybe_compose", sourceHandle: null, sortOrder: 0 },
  ];
  await insertWorkflow(db, tenantId, id, "EA Compose", blocks, edges);
  return id;
}

// Weekly cron-driven workflow. Creates a task assigned to the
// executive-assistant agent with a "Weekly memory reflection" title;
// the agent's SKILL.md handles the rest (read 7 days of feedback
// signals, look for trends, update contextual memory).
async function seedWeeklyReflectionWorkflow(
  db: PostgresJsDatabase,
  tenantId: string,
  agentId: string,
): Promise<string> {
  const id = randomUUID();
  const blocks = [
    { id: "trigger", name: "trigger", kind: "trigger", type: "trigger", config: {} },
    {
      id: "task",
      name: "task",
      kind: "tool",
      type: "tool",
      tool: "framework.tasks.create",
      inputs: {
        title: "Weekly memory reflection",
        description:
          "Pull the last 7 days of feedback signals via executive-assistant.feedback_signals.list. Look for trends across signal kinds (edited_brief patterns, dismissed_action patterns, conflict_resolved choices). For each trend that's been confirmed at least twice, update the relevant contextual memory tag (david.voice, david.lodging.preferences, people.<email>, company.<domain>). Don't write trivial things. Mark task done.",
        originKind: "agent-weekly-reflection",
        assigneeAgentId: agentId,
      },
      config: {},
    },
  ];
  const edges = [
    { id: "e1", sourceBlockId: "trigger", targetBlockId: "task", sourceHandle: null, sortOrder: 0 },
  ];
  await insertWorkflow(db, tenantId, id, "EA Weekly Reflection", blocks, edges);
  return id;
}

// Event-driven workflow: fires on triage.classified. Creates a task
// assigned to the ea-travel-agent, which auto-wakes it. The agent
// reads the inbox item, decides if it's travel, extracts fields, and
// calls reconcile_from_email + bind.
// v0.4.31 — LLM tagger workflow. Cron-fired; the tool itself is the
// guard (counts untagged rows first, skips when zero). When work
// exists the tool creates an agent task and the executive-assistant
// agent batches up to 20 rows per task.
async function seedClassifyPendingWorkflow(
  db: PostgresJsDatabase,
  tenantId: string,
): Promise<string> {
  const id = randomUUID();
  const blocks = [
    { id: "trigger", name: "trigger", kind: "trigger", type: "trigger", config: {} },
    {
      id: "classify",
      name: "classify",
      kind: "tool",
      type: "tool",
      tool: "executive-assistant.compose.classify_pending",
      inputs: {},
      config: {},
    },
  ];
  const edges = [
    { id: "e1", sourceBlockId: "trigger", targetBlockId: "classify", sourceHandle: null, sortOrder: 0 },
  ];
  await insertWorkflow(db, tenantId, id, "EA Classify Pending", blocks, edges);
  return id;
}

async function seedTravelAgentWorkflow(
  db: PostgresJsDatabase,
  tenantId: string,
  agentId: string,
): Promise<string> {
  const id = randomUUID();
  const blocks = [
    {
      id: "trigger",
      name: "trigger",
      kind: "trigger",
      type: "trigger",
      config: { eventType: "triage.classified" },
    },
    {
      id: "task",
      name: "task",
      kind: "tool",
      type: "tool",
      tool: "framework.tasks.create",
      inputs: {
        title: "Travel-agent an inbox item",
        description:
          "An inbox item has just been classified by triage. Read it, decide if it's a travel reservation or update, and if so extract structured fields and persist via trip_legs.reconcile_from_email + email_anchors.bind. Item id: {{trigger.itemId}}. Triage label: {{trigger.label}}.",
        originKind: "agent-travel-agent",
        // v0.4.39: dedup keys off (originKind, originId, tenantId)
        // server-side; the `dedup: true` literal was a no-op (not in
        // the Zod schema) and has been removed.
        originId: "{{trigger.itemId}}",
        assigneeAgentId: agentId,
      },
      config: {},
    },
  ];
  const edges = [
    { id: "e1", sourceBlockId: "trigger", targetBlockId: "task", sourceHandle: null, sortOrder: 0 },
  ];
  await insertWorkflow(db, tenantId, id, "EA Travel Agent on triage", blocks, edges);
  return id;
}

async function insertWorkflow(
  db: PostgresJsDatabase,
  tenantId: string,
  id: string,
  name: string,
  blocks: Array<Record<string, unknown>>,
  edges: Array<Record<string, unknown>>,
) {
  await db.execute(sql`
    INSERT INTO workflows (id, tenant_id, name, type, status, blocks, edges, created_at, updated_at)
    VALUES (${id}, ${tenantId}, ${name}, 'system', 'active',
      ${JSON.stringify(blocks)}::jsonb, ${JSON.stringify(edges)}::jsonb, now(), now())
  `);
}

// ─────────────────────────────────────────────────────────────────
// Routines
// ─────────────────────────────────────────────────────────────────

async function seedRoutines(
  db: PostgresJsDatabase,
  tenantId: string,
  calendarWorkflowId: string,
  scanWorkflowId: string,
  morningWorkflowId: string | null,
  reflectionWorkflowId: string | null,
  classifyPendingWorkflowId: string | null,
) {
  // v0.3.0: routines start ACTIVE. The underlying sync_window tools
  // fail-soft when Google isn't connected (returning ok:true with a
  // skipped reason), so there's no harm in firing every 15 min from
  // install. Once OAuth completes, the next tick picks it up.
  // v0.4.19: synced calendar at 1-min cadence using Google's syncToken
  // for incremental fetches. Steady-state cost is one tiny "no changes"
  // request per minute; only ticks where Google says something changed
  // do any DB work. Worst-case latency from edit → dossier is <60s.
  await db.execute(sql`
    INSERT INTO routines (id, tenant_id, title, workflow_id, cron_expression, status, created_at, updated_at)
    VALUES (${randomUUID()}, ${tenantId}, 'EA Sync Calendar (every 1 min · incremental)', ${calendarWorkflowId},
      '* * * * *', 'active', now(), now())
  `);

  await db.execute(sql`
    INSERT INTO routines (id, tenant_id, title, workflow_id, cron_expression, status, created_at, updated_at)
    VALUES (${randomUUID()}, ${tenantId}, 'EA Scan Meeting Threads (every 15 min)', ${scanWorkflowId},
      '*/15 * * * *', 'active', now(), now())
  `);

  if (morningWorkflowId) {
    // v0.4.0: always-fresh compose. The workflow's maybe_create_task
    // tool hash-guards each tick — a task is only created (LLM wake)
    // when state has shifted since the last snapshot. 06:00 is just
    // one of the 96 daily ticks.
    await db.execute(sql`
      INSERT INTO routines (id, tenant_id, title, workflow_id, cron_expression, status, created_at, updated_at)
      VALUES (${randomUUID()}, ${tenantId}, 'EA Compose (every 15 min · always-fresh)', ${morningWorkflowId},
        '*/15 * * * *', 'active', now(), now())
    `);
  }
  if (reflectionWorkflowId) {
    // Weekly reflection — Monday 06:30 local. After the day's compose
    // has already run so the reflection has a fresh dossier to compare
    // against if needed.
    await db.execute(sql`
      INSERT INTO routines (id, tenant_id, title, workflow_id, cron_expression, status, created_at, updated_at)
      VALUES (${randomUUID()}, ${tenantId}, 'EA Weekly Reflection (Mon 06:30)', ${reflectionWorkflowId},
        '30 6 * * 1', 'active', now(), now())
    `);
  }
  // EA Travel Agent workflow is event-driven (triage.classified) —
  // no routine needed. It fires whenever triage classifies an item.

  // v0.4.31 — LLM tagger routine. Every 30 min: tool counts untagged
  // rows and only wakes the agent when there's actual work. Cheap
  // when steady-state (zero rows → no agent task created).
  if (classifyPendingWorkflowId) {
    await db.execute(sql`
      INSERT INTO routines (id, tenant_id, title, workflow_id, cron_expression, status, created_at, updated_at)
      VALUES (${randomUUID()}, ${tenantId}, 'EA Classify Pending (every 30 min)', ${classifyPendingWorkflowId},
        '*/30 * * * *', 'active', now(), now())
    `);
  }
}
