// executive-assistant.compose.maybe_create_task
//
// The hash-guard tool that sits between the always-fresh cron tick
// and the executive-assistant agent. Every 15 minutes:
//
//   1. Compute the current state hash for (tenant, today).
//   2. Read the latest composed snapshot's stored state_hash.
//   3. If they match → SKIP. No task created, no LLM wake. Return
//      ok:true with { skipped: true, reason: "state_unchanged" }.
//   4. If they differ (or there's no prior snapshot) → dispatch
//      framework.tasks.create assigning the executive-assistant
//      agent. Return ok:true with { created: true, taskId }.
//
// 06:00 is just one of the 96 daily ticks — there's no separate
// morning routine. On the first tick after install, the hash
// differs from "no prior snapshot" and we create the canonical
// morning task. Subsequent ticks within the day only fire when
// something genuinely shifted.

import { z } from "@boringos/module-sdk";
import type { Tool, ToolContext, ToolResult } from "@boringos/module-sdk";
import { invoke } from "@boringos/agent";
import { and, asc, desc, eq, gte, inArray, isNull, lte, sql } from "drizzle-orm";
import { snapshots } from "../schema/snapshots.js";
import { meetings } from "../schema/meetings.js";
import { oooWindows } from "../schema/ooo_windows.js";
import { tripLegs } from "../schema/trip_legs.js";
import { timelineItems } from "../schema/timeline_items.js";
import { computeStateHash } from "../services/compose_hash.js";
import { computeDaySignal } from "../services/day_signal.js";
import { trace } from "../services/trace.js";
import type { EaDeps } from "./deps.js";

// v0.4.34/35 — phase markers for the brief-generation diagnostic trace.
// Mirrors to stderr AND the trace file (see services/trace.ts).
function phase(msg: string): void {
  trace(`[ea.compose] ${msg}`);
}

export function createComposeTools(deps: EaDeps): Tool[] {
  const maybeCreateTask: Tool = {
    name: "compose.maybe_create_task",
    description:
      "Hash-guarded gate for the always-fresh compose routine. Compares the current compose-input state hash to the latest snapshot's stored hash. Creates a fresh task for the executive-assistant agent only when something material has shifted; otherwise returns skipped:true and saves the LLM wake.",
    inputs: z.object({
      // forDate defaults to today (host tz) when absent.
      forDate: z.string().date().optional(),
    }),
    async handler(
      input: { forDate?: string },
      ctx: ToolContext,
    ): Promise<ToolResult> {
      if (!deps.toolRegistry) {
        return {
          ok: true,
          result: {
            data: { skipped: true, reason: "tool_registry_unavailable" },
          },
        };
      }

      // Resolve today's date. The host's clock is the authority.
      const forDate =
        input.forDate ?? new Date().toISOString().slice(0, 10);
      phase(`tick — forDate=${forDate} tenant=${ctx.tenantId.slice(0, 8)}`);

      // 1. Compute current state hash.
      let currentHash: string;
      const hashStart = Date.now();
      try {
        currentHash = await computeStateHash(deps.db, ctx.tenantId, forDate);
        phase(`hash computed in ${Date.now() - hashStart}ms → ${currentHash.slice(0, 8)}`);
      } catch (err) {
        return {
          ok: false,
          error: {
            code: "internal",
            message: `state hash failed: ${err instanceof Error ? err.message : String(err)}`,
            retryable: true,
          },
        };
      }

      // 2. Read latest composed snapshot for today (the partial unique
      //    index guarantees at most one).
      const priorRows = await deps.db
        .select({ stateHash: snapshots.stateHash })
        .from(snapshots)
        .where(
          and(
            eq(snapshots.tenantId, ctx.tenantId),
            eq(snapshots.snapshotDate, forDate),
            eq(snapshots.status, "composed"),
          ),
        )
        .orderBy(desc(snapshots.generatedAt))
        .limit(1);
      const priorHash = priorRows[0]?.stateHash ?? null;

      phase(
        `prior=${priorHash ? priorHash.slice(0, 8) : "none"} current=${currentHash.slice(0, 8)} ${
          priorHash === currentHash ? "MATCH" : "CHANGED"
        }`,
      );

      // 3. Hash matches → skip silently. The agent is not woken;
      //    no task is created.
      if (priorHash && priorHash === currentHash) {
        phase("skip — state unchanged, no agent wake");
        return {
          ok: true,
          result: {
            data: {
              skipped: true,
              reason: "state_unchanged",
              hash: currentHash,
              forDate,
            },
          },
        };
      }

      // 4. Hash differs (or no prior snapshot). Construct originId for
      //    dedup, then pre-check for an inflight task with the same
      //    (origin_kind, origin_id, tenant) before creating a new one.
      //
      //    v0.4.41 — Fix A: multiple triggers (install hook + UI mount +
      //    15-min cron + connector.connected workflow) can all fire
      //    within the agent's first run, before any snapshot has been
      //    written to hash-guard against. Without this pre-check, each
      //    trigger creates a separate task, all woken (sequentially via
      //    auto-rewake-on-success) into N agent runs for one
      //    user-visible brief. Catches the 99% case (triggers seconds
      //    apart). Sub-millisecond races still need a framework-side
      //    DB unique constraint — see docs/_brainstorm/.
      const originKindForThis =
        priorHash === null ? "agent-morning-compose" : "agent-compose-refresh";
      const originIdForThis =
        priorHash === null
          ? forDate
          : `${forDate}:${currentHash.slice(0, 8)}`;

      const inflight = (await deps.db.execute(sql`
        SELECT id FROM tasks
        WHERE tenant_id = ${ctx.tenantId}
          AND origin_kind = ${originKindForThis}
          AND origin_id = ${originIdForThis}
          AND status IN ('todo', 'running')
          AND created_at > now() - interval '15 minutes'
        ORDER BY created_at DESC
        LIMIT 1
      `)) as unknown as Array<{ id: string }>;

      if (inflight.length > 0) {
        phase(
          `skip — task already inflight (id=${inflight[0]!.id.slice(0, 8)})`,
        );
        return {
          ok: true,
          result: {
            data: {
              skipped: true,
              reason: "task_inflight",
              taskId: inflight[0]!.id,
              hash: currentHash,
              forDate,
            },
          },
        };
      }

      // 5. Find the EA agent (role = "executive-assistant"). Bail
      //    gracefully if the agent wasn't seeded (no Claude runtime at
      //    install time).
      //    v0.4.54 — prefer ea-day-composer (new role); fall back to
      //    legacy executive-assistant role on tenants installed before
      //    v0.4.54.
      const agentRows = (await deps.db.execute(sql`
        SELECT id, role FROM agents
        WHERE tenant_id = ${ctx.tenantId}
          AND role IN ('ea-day-composer', 'executive-assistant')
        ORDER BY (role = 'ea-day-composer') DESC
        LIMIT 1
      `)) as unknown as Array<{ id: string; role: string }>;
      const assigneeAgentId = agentRows[0]?.id;
      if (!assigneeAgentId) {
        // No agent — this can happen on tenants without a Claude
        // runtime. Skip rather than fail; reinstall path is the cure.
        return {
          ok: true,
          result: {
            data: {
              skipped: true,
              reason: "ea_agent_missing",
              hash: currentHash,
              forDate,
            },
          },
        };
      }

      const description =
        priorHash === null
          ? `Compose today's morning dossier. Read meetings + trips + OOO for today, write per-meeting briefs, surface verbatim excerpts, extract action items, then write the snapshot and timeline. Mark task done when the snapshot row is in place.`
          : `State has changed since the last compose at hash ${priorHash.slice(0, 8)}…. Re-read meetings + trips + OOO for today, recompose any shifted per-meeting briefs, update the snapshot's narrative_brief, refresh timeline items. Snapshot will store the new hash automatically. Mark task done when the snapshot row is in place.`;

      const createResult = await invoke<unknown, { id: string; wake?: unknown }>(
        { registry: deps.toolRegistry, db: deps.db as unknown as never },
        "framework.tasks.create",
        {
          title:
            priorHash === null
              ? "Compose morning dossier"
              : "Recompose dossier — state changed",
          description,
          originKind: originKindForThis,
          originId: originIdForThis,
          assigneeAgentId,
        },
        { ...ctx, invokedBy: "internal" },
      );

      if (!createResult.ok) {
        return {
          ok: false,
          error: createResult.error,
        };
      }

      // v0.4.39: framework.tasks.create returns `{ id, wake }` directly
      // in `result` — not wrapped in `result.data`. Reading `.data.id`
      // resolved to null every time, hence "task null" in the trace.
      const taskId = createResult.result?.id ?? null;
      phase(
        `task created id=${taskId?.slice(0, 8) ?? "?"} (${priorHash === null ? "first compose" : "refresh"})`,
      );
      console.log(
        `[ea.compose.maybe_create_task] ${priorHash === null ? "first compose" : "refresh"} — task ${taskId} for tenant ${ctx.tenantId} (hash ${currentHash.slice(0, 8)}…)`,
      );

      // v0.4.55 — spawn per-meeting briefer tasks server-side, right
      // after the day-brief task lands. Haiku consistently stopped
      // mid-procedure when the day-composer agent was responsible for
      // this step (see v0.4.54 measurement). Internal invoke
      // (invokedBy=internal) bypasses the v0.4.45 agent gate on
      // compose.prepare_meeting_briefs. Non-fatal: a spawn failure
      // here does NOT block the day brief from rendering.
      try {
        await invoke<unknown, unknown>(
          { registry: deps.toolRegistry, db: deps.db as unknown as never },
          "executive-assistant.compose.prepare_meeting_briefs",
          { days: 1 },
          { ...ctx, invokedBy: "internal" },
        );
        phase("briefer tasks spawn fired");
      } catch (err) {
        phase(
          `briefer tasks spawn failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      return {
        ok: true,
        result: {
          data: {
            created: true,
            taskId,
            hashChanged: true,
            hash: currentHash,
            priorHash,
            forDate,
          },
        },
      };
    },
  };

  // Immediately create an agent task to write prep briefs for upcoming
  // meetings — no hash guard, no snapshot, no timeline. Used on install
  // (so the user has briefs the moment they open the module) and from
  // the meeting drawer's "Generate brief" button.
  const prepareMeetingBriefs: Tool = {
    name: "compose.prepare_meeting_briefs",
    description:
      "Internal / UI-only tool. Creates a fresh agent task to write prep briefs for meetings that lack one. Used by the install hook (days=7 sweep) and the meeting drawer's auto-trigger + Refresh button. **Agents must not call this tool** — compose meeting briefs inline inside the Day Brief run by calling meetings.get + memory.recall + meetings.set_brief directly.",
    inputs: z.object({
      days: z.number().int().positive().max(30).optional(),
      meetingIds: z.array(z.string().uuid()).optional(),
    }),
    async handler(
      input: { days?: number; meetingIds?: string[] },
      ctx: ToolContext,
    ): Promise<ToolResult> {
      // v0.4.45: hard-gate the agent out of self-spawning per-meeting
      // brief tasks. The Day Brief flow's SKILL.md procedure tells the
      // agent to inline meeting brief composition (meetings.get +
      // memory.recall + meetings.set_brief) inside the same run. If the
      // agent still calls this tool, it would spawn a separate task per
      // meeting, each one becoming its own ~90-180s agent run because
      // queue concurrency = 1 + auto-rewake-on-success. With 4 meetings
      // that's 5 sequential runs (~10 min wall-clock) for one user-
      // visible morning brief. Block the call and teach the agent the
      // correct alternative via a retryable=false error.
      if (ctx.invokedBy === "agent") {
        return {
          ok: false,
          error: {
            code: "permission_denied",
            message:
              "compose.prepare_meeting_briefs is not callable from an agent context. Compose meeting briefs inline inside this same run: for each meeting, call meetings.get({ meetingId }) → memory.recall({ query: \"people.<email>\" }) per attendee → meetings.set_brief({ meetingId, brief }) with the prose. Do not create a separate task per meeting.",
            retryable: false,
          },
        };
      }

      if (!deps.toolRegistry) {
        return {
          ok: true,
          result: { data: { skipped: true, reason: "tool_registry_unavailable" } },
        };
      }

      // v0.4.54 — prefer ea-meeting-briefer (the new per-meeting
      // agent), fall back to the legacy executive-assistant role for
      // tenants that haven't been re-seeded yet.
      const agentRows = (await deps.db.execute(sql`
        SELECT id, role FROM agents
        WHERE tenant_id = ${ctx.tenantId}
          AND role IN ('ea-meeting-briefer', 'executive-assistant')
        ORDER BY (role = 'ea-meeting-briefer') DESC
        LIMIT 1
      `)) as unknown as Array<{ id: string; role: string }>;
      const assigneeAgentId = agentRows[0]?.id;
      if (!assigneeAgentId) {
        return {
          ok: true,
          result: { data: { skipped: true, reason: "ea_agent_missing" } },
        };
      }

      // Resolve which meetings need briefs.
      let targets: Array<{ id: string; title: string; startsAt: Date }>;
      if (input.meetingIds && input.meetingIds.length > 0) {
        targets = await deps.db
          .select({ id: meetings.id, title: meetings.title, startsAt: meetings.startsAt })
          .from(meetings)
          .where(
            and(
              eq(meetings.tenantId, ctx.tenantId),
              inArray(meetings.id, input.meetingIds),
            ),
          );
      } else {
        // v0.1.6 — filter expanded. The prior `startsAt >= now` excluded
        // today's already-past and in-progress meetings, which is the
        // wrong product behavior. Users want briefs for ALL of today's
        // meetings (past, in-progress, future) so they can reference
        // them throughout the day, plus future meetings within `days`.
        // New filter: today (in tenant local date) OR future within window.
        const days = input.days ?? 7;
        const now = new Date();
        const windowEnd = new Date(now.getTime() + days * 86_400_000);
        const todayStart = new Date(
          `${now.toISOString().slice(0, 10)}T00:00:00.000Z`,
        );
        const todayEnd = new Date(
          `${now.toISOString().slice(0, 10)}T23:59:59.999Z`,
        );
        targets = await deps.db
          .select({ id: meetings.id, title: meetings.title, startsAt: meetings.startsAt })
          .from(meetings)
          .where(
            and(
              eq(meetings.tenantId, ctx.tenantId),
              // include if (any of today) OR (future within window)
              sql`(${meetings.startsAt} BETWEEN ${todayStart} AND ${todayEnd}) OR (${meetings.startsAt} > ${now} AND ${meetings.startsAt} <= ${windowEnd})`,
              isNull(meetings.brief),
            ),
          )
          .orderBy(asc(meetings.startsAt));
        // v0.1.5 — diagnostic: when only a partial set comes back vs
        // what the user has on the calendar, we want to see WHY (kind
        // filter? hidden FK? something else?). Log every candidate +
        // each one's eligibility flag to /tmp/ea-trace.log.
        const allTodayWindow = await deps.db
          .select({ id: meetings.id, title: meetings.title, startsAt: meetings.startsAt, brief: meetings.brief, kind: meetings.kind })
          .from(meetings)
          .where(
            and(
              eq(meetings.tenantId, ctx.tenantId),
              lte(meetings.startsAt, windowEnd),
            ),
          )
          .orderBy(asc(meetings.startsAt));
        const summary = allTodayWindow.map((m) => {
          const reasons: string[] = [];
          if (m.startsAt < now) reasons.push("past");
          if (m.brief != null) reasons.push("has_brief");
          const passed = reasons.length === 0;
          return `${m.id.slice(0, 8)} "${m.title}" kind=${m.kind ?? "untagged"} ${passed ? "MATCH" : `skipped(${reasons.join(",")})`}`;
        }).join(" | ");
        phase(`prep_briefs CANDIDATES (days=${days}, now=${now.toISOString()}, windowEnd=${windowEnd.toISOString()}): ${summary || "<none>"}`);
      }

      phase(
        `prep_briefs — ${targets.length} target meeting${targets.length === 1 ? "" : "s"}`,
      );
      if (targets.length === 0) {
        phase("prep_briefs skip — nothing needs a brief");
        return {
          ok: true,
          result: { data: { skipped: true, reason: "no_meetings_need_briefs" } },
        };
      }

      // v0.4.54 — split into one task per meeting. Each task wakes
      // the ea-meeting-briefer agent with a SINGLE-meeting scope,
      // keeping per-run tool count small (~5-6) so haiku can drive
      // each task to completion. Mirrors the hebbs-crm pattern where
      // each agent run handles one atomic unit of work.
      const invokeDeps = {
        registry: deps.toolRegistry,
        db: deps.db as unknown as never,
      };
      const createdTaskIds: string[] = [];
      for (const meeting of targets) {
        const when = meeting.startsAt.toLocaleString("en-GB", {
          weekday: "short",
          month: "short",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        });
        const meetingDescription = `Write the prep brief for ONE meeting.

Meeting: "${meeting.title}" at ${when}
meetingId: ${meeting.id}

Procedure (curl examples in your SKILL.md):
1. meetings.get with { meetingId: "${meeting.id} "} — read description, attendees, location, conferenceLink
2. For each non-internal attendee, memory.recall { query: "people.<email>" }
3. Write an 80-word prep brief using ONLY the agenda description + memory recall results
4. meetings.set_brief with { meetingId: "${meeting.id}", brief: "<your prose>" }
5. (Optional) action_items.create for any concrete open items
6. framework.comments.post with a one-line summary
7. framework.tasks.patch with { taskId, status: "done" }

Hard rules:
- Never infer an attendee's role from email address or domain.
- If memory has nothing, write "no prior context on file" — do not invent.
- No superlatives. No fabricated facts.`;

        const createResult = await invoke<unknown, { id: string; wake?: unknown }>(
          invokeDeps,
          "framework.tasks.create",
          {
            title: `Prep brief — ${meeting.title}`,
            description: meetingDescription,
            originKind: "agent-meeting-brief",
            originId: `brief:${meeting.id}`,
            assigneeAgentId,
          },
          { ...ctx, invokedBy: "internal" },
        );

        if (createResult.ok && createResult.result?.id) {
          createdTaskIds.push(createResult.result.id);
        } else if (!createResult.ok) {
          phase(
            `prep_briefs ERROR creating task for ${meeting.id}: ${createResult.error.message}`,
          );
        }
      }

      console.log(
        `[ea.compose.prepare_meeting_briefs] created ${createdTaskIds.length} task(s) for ${targets.length} meetings (tenant ${ctx.tenantId})`,
      );

      return {
        ok: true,
        result: {
          data: {
            created: createdTaskIds.length > 0,
            taskIds: createdTaskIds,
            meetingCount: targets.length,
          },
        },
      };
    },
  };

  // v0.4.25 — Pre-digest day signal. Single tool call that returns
  // the agent's structural read on today: meeting count, ooo count,
  // shape label (quiet / morning-heavy / afternoon-heavy / etc.),
  // first / last local times, travel state. Removes inference work
  // from the LLM's brief-composition path.
  const daySignal: Tool = {
    name: "compose.day_signal",
    description:
      "Read the day's structural signal: meeting count, ooo count, dayShape label (quiet | morning-heavy | afternoon-heavy | evening-heavy | after-hours | balanced | back-to-back), first/last local times, and travel state (isAway, current city, home city). Server-computed; use the labels verbatim in prose so the agent does not re-derive them.",
    inputs: z.object({
      forDate: z.string().date().optional(),
    }),
    async handler(
      input: { forDate?: string },
      ctx: ToolContext,
    ): Promise<ToolResult> {
      const forDate =
        input.forDate ?? new Date().toISOString().slice(0, 10);
      const signal = await computeDaySignal(deps.db, ctx, deps, forDate);
      return { ok: true, result: { data: signal } };
    },
  };

  // v0.4.31 — LLM tagger workflow trigger. Counts kind='untagged'
  // meetings; if any exist, creates one agent task for the
  // executive-assistant agent that says "classify these in caveman
  // mode." The task instructs the agent to read memory for any
  // user.kind_preference notes first, then decide.
  const classifyPending: Tool = {
    name: "compose.classify_pending",
    description:
      "Trigger the LLM tagger when there are kind='untagged' meeting-table rows. Creates one agent task that batches up to 20 rows. The agent reads user.kind_preference memory in its prompt so user overrides shape future classifications. Skips when no untagged rows exist.",
    inputs: z.object({}),
    async handler(_input: unknown, ctx: ToolContext): Promise<ToolResult> {
      if (!deps.toolRegistry) {
        return {
          ok: true,
          result: { data: { skipped: true, reason: "tool_registry_unavailable" } },
        };
      }
      const agentRows = (await deps.db.execute(sql`
        SELECT id FROM agents
        WHERE tenant_id = ${ctx.tenantId}
          AND role = 'executive-assistant'
        LIMIT 1
      `)) as unknown as Array<{ id: string }>;
      const assigneeAgentId = agentRows[0]?.id;
      if (!assigneeAgentId) {
        return {
          ok: true,
          result: { data: { skipped: true, reason: "ea_agent_missing" } },
        };
      }

      // Quick count first — avoid spinning up an agent for zero work.
      const countRows = (await deps.db.execute(sql`
        SELECT count(*)::int AS n
        FROM executive_assistant__meetings
        WHERE tenant_id = ${ctx.tenantId}
          AND kind = 'untagged'
          AND kind_locked = false
      `)) as unknown as Array<{ n: number }>;
      const untaggedCount = Number(countRows[0]?.n ?? 0);
      phase(`classify_pending — ${untaggedCount} untagged row(s)`);
      if (untaggedCount === 0) {
        phase("classify_pending skip — nothing to classify");
        return {
          ok: true,
          result: { data: { skipped: true, reason: "no_untagged" } },
        };
      }

      const description = `Caveman-mode classification pass. Some calendar items couldn't be classified by the deterministic rule (no video link, no meeting keyword, no imperative verb pattern, no external attendees) and are sitting as kind='untagged'.

Your job:

1. Call memory.recall with query "user.kind_preference" to read any prior user overrides. These tell you how this user thinks about items — apply the patterns when they fit.

2. Call executive-assistant.meetings.list_untagged with no arguments. You get up to 20 rows with id, title, location, conferenceLink, externalAttendees.

3. For each row, decide one of: meeting, event, task. Guidance:
   - meeting: work-coded — agendas, prep, decisions, calls. Even without a link.
   - event: social or personal commitment, often with a place to be (lunches, family events, recitals, dinners, doctors' appointments).
   - task: solo errands, focus blocks, to-dos. Short, action-shaped titles.

4. For each row, call executive-assistant.meetings.classify_set_kind with meetingId and the chosen kind. This tool sets the kind WITHOUT locking the row — the user can still override.

5. Mark the task done when every row has been classified.

There are ${untaggedCount} untagged items right now.`;

      const createResult = await invoke<unknown, { id: string; wake?: unknown }>(
        { registry: deps.toolRegistry, db: deps.db as unknown as never },
        "framework.tasks.create",
        {
          title:
            untaggedCount === 1
              ? "Classify untagged item"
              : `Classify ${untaggedCount} untagged items`,
          description,
          originKind: "agent-classify-pending",
          // v0.4.39: framework dedups on (originKind, originId, tenantId)
          // when originId is present. Constant originId here = singleton
          // tagger per tenant; concurrent 30-min ticks collapse to one
          // in-flight task. The literal `dedup: true` was dropped — the
          // Zod schema doesn't accept it; originId carries the intent.
          originId: "ea-classify-pending",
          assigneeAgentId,
        },
        { ...ctx, invokedBy: "internal" },
      );

      if (!createResult.ok) {
        return { ok: false, error: createResult.error };
      }

      return {
        ok: true,
        result: {
          data: {
            created: true,
            // v0.4.39: framework returns `{ id, wake }` directly in result.
            taskId: createResult.result?.id ?? null,
            untaggedCount,
          },
        },
      };
    },
  };

  // v0.4.54 — Pre-digested context for the Day Brief composer.
  // Single tool call returns: meetings (with attendees + descriptions),
  // ooo, trips (planned + in_progress merged), conflicts, day_signal,
  // displayName, location (current or home), weather (already fetched),
  // and a memoryEmpty flag. The agent gets the whole picture from one
  // call instead of 7+ separate reads — keeps its per-run scope small
  // enough for haiku to drive end-to-end.
  const dayContext: Tool = {
    name: "compose.day_context",
    description:
      "Pre-digested context for the Day Brief composer agent. ONE call returns everything the agent needs to compose today's narrative + snapshot: meetings (with attendees + description + localized times), ooo spans, trips (planned + in_progress), conflicts, day_signal (dayShape, counts, travel state), displayName, location, weather, memoryEmpty flag. Use this instead of calling meetings.list / ooo.list / trips.list / conflicts.list / compose.day_signal / preferences.get / memory.recall separately.",
    inputs: z.object({
      forDate: z.string().date().optional(),
    }),
    async handler(
      input: { forDate?: string },
      ctx: ToolContext,
    ): Promise<ToolResult> {
      if (!deps.toolRegistry) {
        return {
          ok: true,
          result: {
            data: { skipped: true, reason: "tool_registry_unavailable" },
          },
        };
      }
      const forDate =
        input.forDate ?? new Date().toISOString().slice(0, 10);
      const startOfDay = new Date(`${forDate}T00:00:00.000Z`).toISOString();
      const endOfDay = new Date(`${forDate}T23:59:59.999Z`).toISOString();
      const invokeOpts = { registry: deps.toolRegistry, db: deps.db as unknown as never };
      const ctxInt: ToolContext = { ...ctx, invokedBy: "internal" };

      // Day signal — server-side aggregation we already have.
      const signal = await computeDaySignal(deps.db, ctx, deps, forDate);

      // Parallel-invoke the read tools we need.
      const [
        meetingsRes,
        oooRes,
        plannedTripsRes,
        inProgressTripsRes,
        conflictsRes,
        displayNameRes,
        voiceRes,
        currentLocRes,
      ] = await Promise.all([
        invoke<unknown, { data: unknown[] }>(invokeOpts, "executive-assistant.meetings.list", { startsAfter: startOfDay, endsBefore: endOfDay, limit: 500 }, ctxInt),
        invoke<unknown, { data: unknown[] }>(invokeOpts, "executive-assistant.ooo.list", { startsAfter: startOfDay, endsBefore: endOfDay }, ctxInt),
        invoke<unknown, { data: unknown[] }>(invokeOpts, "executive-assistant.trips.list", { status: "planned" }, ctxInt),
        invoke<unknown, { data: unknown[] }>(invokeOpts, "executive-assistant.trips.list", { status: "in_progress" }, ctxInt),
        invoke<unknown, { data: unknown[] }>(invokeOpts, "executive-assistant.conflicts.list", { forDate }, ctxInt),
        invoke<unknown, { data: { value?: { name?: string } | null } }>(invokeOpts, "executive-assistant.preferences.get", { key: "display_name" }, ctxInt),
        invoke<unknown, { data: unknown }>(invokeOpts, "memory.recall", { query: "user.voice" }, ctxInt),
        invoke<unknown, { data: unknown }>(invokeOpts, "memory.recall", { query: "user.current_location" }, ctxInt),
      ]);

      // Memory empty signal: if user.voice returned nothing, treat the
      // whole memory tree as empty so the agent skips per-attendee
      // recalls downstream.
      const memoryEmpty = !voiceRes.ok || !voiceRes.result?.data;

      // Pick a location: current_location first, then home_location.
      type LocVal = { label?: string; latitude?: number; longitude?: number; tz?: string };
      let location: LocVal | null = null;
      const currentLocVal = currentLocRes.ok ? (currentLocRes.result?.data as { value?: LocVal } | null)?.value ?? null : null;
      if (currentLocVal && typeof currentLocVal === "object" && typeof currentLocVal.latitude === "number") {
        location = currentLocVal;
      } else {
        const homeLocRes = await invoke<unknown, { data: { value?: LocVal } | null }>(
          invokeOpts,
          "memory.recall",
          { query: "user.home_location" },
          ctxInt,
        );
        const homeLocVal = homeLocRes.ok ? (homeLocRes.result?.data as { value?: LocVal } | null)?.value ?? null : null;
        if (homeLocVal && typeof homeLocVal === "object" && typeof homeLocVal.latitude === "number") {
          location = homeLocVal;
        }
      }

      // Fetch weather if we have coords. weather.fetch_for_date upserts
      // and returns the row, so it doubles as a read-or-fetch.
      let weather: unknown = null;
      if (location && location.latitude != null && location.longitude != null) {
        try {
          const weatherRes = await invoke<unknown, { data: unknown }>(
            invokeOpts,
            "executive-assistant.weather.fetch_for_date",
            {
              forDate,
              locationLabel: location.label ?? "Unknown",
              latitude: location.latitude,
              longitude: location.longitude,
              tz: location.tz ?? "UTC",
            },
            ctxInt,
          );
          if (weatherRes.ok) weather = weatherRes.result?.data ?? null;
        } catch {
          // Upstream weather unavailable — skip silently.
        }
      }

      return {
        ok: true,
        result: {
          data: {
            forDate,
            signal,
            meetings: meetingsRes.ok ? meetingsRes.result?.data ?? [] : [],
            ooo: oooRes.ok ? oooRes.result?.data ?? [] : [],
            trips: [
              ...(plannedTripsRes.ok ? plannedTripsRes.result?.data ?? [] : []),
              ...(inProgressTripsRes.ok ? inProgressTripsRes.result?.data ?? [] : []),
            ],
            conflicts: conflictsRes.ok ? conflictsRes.result?.data ?? [] : [],
            displayName: displayNameRes.ok
              ? (displayNameRes.result?.data as { value?: { name?: string } } | undefined)?.value?.name ?? null
              : null,
            location,
            weather,
            memoryEmpty,
          },
        },
      };
    },
  };

  // v0.1.4 — atomic finalize for the meeting-briefer agent.
  // Bundles set_brief + comments.post + tasks.patch(done) into one
  // server call. The briefer's SKILL.md procedure ends with this
  // single call instead of three separate ones — eliminates the
  // haiku planning-mode trap that kept narrating the tail of the
  // procedure ("Now saving the brief and marking the task complete")
  // without actually emitting the tool_use blocks. Atomicity here
  // means the agent has nothing to narrate: either it called this
  // tool or it didn't.
  const writeMeetingBrief: Tool = {
    name: "compose.write_meeting_brief",
    description:
      "Atomically finalize a meeting prep brief. Saves the brief on the meeting, posts a completion comment to the corresponding agent-meeting-brief task (looked up by meetingId via origin_id), and marks that task done. Use this as the LAST step of the briefer agent's procedure instead of calling meetings.set_brief + framework.comments.post + framework.tasks.patch separately. Pass { meetingId, brief, comment? } — taskId is resolved internally.",
    inputs: z.object({
      meetingId: z.string().uuid(),
      brief: z.string().min(1),
      comment: z.string().optional(),
    }),
    async handler(
      input: { meetingId: string; brief: string; comment?: string },
      ctx: ToolContext,
    ): Promise<ToolResult> {
      // 1. Save the brief with tenant guard. Update returning gives us
      //    the row so we can confirm it actually existed.
      const updated = await deps.db
        .update(meetings)
        .set({ brief: input.brief, updatedAt: new Date() })
        .where(
          and(eq(meetings.id, input.meetingId), eq(meetings.tenantId, ctx.tenantId)),
        )
        .returning({ id: meetings.id });
      if (!updated.length) {
        return {
          ok: false,
          error: {
            code: "not_found",
            message: "Meeting not found for this tenant. Brief not saved.",
            retryable: false,
          },
        };
      }

      // 2. Look up the briefer task for this meeting. originId pattern
      //    set by compose.prepare_meeting_briefs is `brief:${meetingId}`.
      const taskRows = (await deps.db.execute(sql`
        SELECT id FROM tasks
        WHERE tenant_id = ${ctx.tenantId}
          AND origin_kind = 'agent-meeting-brief'
          AND origin_id = ${`brief:${input.meetingId}`}
          AND status != 'done'
        ORDER BY created_at DESC
        LIMIT 1
      `)) as unknown as Array<{ id: string }>;
      const taskId = taskRows[0]?.id ?? null;

      // 3. If we found a matching task, finalize it: post comment +
      //    patch done. If no task (e.g. brief refreshed from UI button
      //    rather than a task), skip silently — the brief is already
      //    saved which is the primary contract.
      if (taskId && deps.toolRegistry) {
        const invokeDeps = {
          registry: deps.toolRegistry,
          db: deps.db as unknown as never,
        };
        const ctxInt: ToolContext = { ...ctx, invokedBy: "internal" };
        try {
          await invoke<unknown, unknown>(
            invokeDeps,
            "framework.comments.post",
            {
              taskId,
              body:
                input.comment ??
                `Brief composed (${input.brief.length} chars).`,
            },
            ctxInt,
          );
        } catch (err) {
          phase(
            `write_meeting_brief: comment failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        try {
          await invoke<unknown, unknown>(
            invokeDeps,
            "framework.tasks.patch",
            { taskId, status: "done" },
            ctxInt,
          );
        } catch (err) {
          phase(
            `write_meeting_brief: tasks.patch failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      return {
        ok: true,
        result: {
          data: {
            saved: true,
            meetingId: input.meetingId,
            briefChars: input.brief.length,
            taskFinalized: !!taskId,
            taskId,
          },
        },
      };
    },
  };

  // v0.1.5 — atomic finalize for the day-composer agent.
  // Bundles snapshots.create + timeline_items.create_batch +
  // comments.post + tasks.patch(done) into one server call.
  //
  // The day-composer agent only needs to:
  //   1. Call compose.day_context (read everything)
  //   2. Compose narrative prose (no tool)
  //   3. Call compose.write_day_brief({ narrative })
  //
  // Server queries today's meetings/ooo/trip_legs and builds the
  // timeline items list internally. The agent doesn't have to thread
  // UUIDs from one call to the next (the failure we kept seeing —
  // agent passed "null" / "garage-visit" / etc. instead of real
  // UUIDs from prior responses).
  const writeDayBrief: Tool = {
    name: "compose.write_day_brief",
    description:
      "Atomically finalize today's Day Brief. Save the narrative as a snapshot, write timeline items for every meeting/ooo/trip leg on today, post a completion comment, and mark the agent-morning-compose task done. The agent only passes { narrative, completionComment? } — the server handles all internal UUID threading, task lookup, and finalization. Use this as the LAST step of the day-composer agent's procedure instead of calling snapshots.create + timeline_items.create_batch + framework.comments.post + framework.tasks.patch separately.",
    inputs: z.object({
      narrative: z.string().min(1),
      completionComment: z.string().optional(),
      elevatedRefIds: z.array(z.string().uuid()).optional(),
    }),
    async handler(
      input: {
        narrative: string;
        completionComment?: string;
        elevatedRefIds?: string[];
      },
      ctx: ToolContext,
    ): Promise<ToolResult> {
      const forDate = new Date().toISOString().slice(0, 10);
      const dayStart = new Date(`${forDate}T00:00:00.000Z`);
      const dayEnd = new Date(`${forDate}T23:59:59.999Z`);
      const elevated = new Set(input.elevatedRefIds ?? []);

      // 1. Save the snapshot.
      const stateHash = await computeStateHash(deps.db, ctx.tenantId, forDate).catch(
        () => null,
      );
      const [snapshot] = await deps.db
        .insert(snapshots)
        .values({
          tenantId: ctx.tenantId,
          snapshotDate: forDate,
          narrativeBrief: input.narrative,
          stateHash: stateHash ?? "",
          status: "composed",
        })
        .returning();
      if (!snapshot?.id) {
        return {
          ok: false,
          error: {
            code: "internal",
            message: "Failed to save snapshot row.",
            retryable: true,
          },
        };
      }

      // 2. Build the timeline items list by querying today's domain
      //    rows. The agent doesn't need to thread UUIDs.
      const todayMeetings = await deps.db
        .select({ id: meetings.id, startsAt: meetings.startsAt, endsAt: meetings.endsAt })
        .from(meetings)
        .where(
          and(
            eq(meetings.tenantId, ctx.tenantId),
            gte(meetings.startsAt, dayStart),
            lte(meetings.startsAt, dayEnd),
          ),
        )
        .orderBy(asc(meetings.startsAt));

      const todayOoo = await deps.db
        .select({ id: oooWindows.id, startsAt: oooWindows.startsAt, endsAt: oooWindows.endsAt })
        .from(oooWindows)
        .where(
          and(
            eq(oooWindows.tenantId, ctx.tenantId),
            gte(oooWindows.startsAt, dayStart),
            lte(oooWindows.startsAt, dayEnd),
          ),
        );

      const todayTripLegs = await deps.db
        .select({ id: tripLegs.id, startsAt: tripLegs.startsAt, endsAt: tripLegs.endsAt })
        .from(tripLegs)
        .where(
          and(
            gte(tripLegs.startsAt, dayStart),
            lte(tripLegs.startsAt, dayEnd),
          ),
        );

      type Row = { id: string; startsAt: Date; endsAt: Date | null };
      const items: Array<{
        snapshotId: string;
        kind: "meeting" | "trip_leg" | "ooo";
        refId: string;
        startsAt: Date;
        endsAt: Date | null;
        elevated: boolean;
        elevationReason: null;
        sortOrder: number;
      }> = [];

      function pushItem(row: Row, kind: "meeting" | "trip_leg" | "ooo", order: number) {
        items.push({
          snapshotId: snapshot.id,
          kind,
          refId: row.id,
          startsAt: row.startsAt,
          endsAt: row.endsAt ?? null,
          elevated: elevated.has(row.id),
          elevationReason: null,
          sortOrder: order,
        });
      }

      let order = 0;
      for (const m of todayMeetings as Row[]) pushItem(m, "meeting", order++);
      for (const o of todayOoo as Row[]) pushItem(o, "ooo", order++);
      for (const t of todayTripLegs as Row[]) pushItem(t, "trip_leg", order++);

      if (items.length > 0) {
        await deps.db.insert(timelineItems).values(items);
      }

      // 3. Find the agent-morning-compose task for today and finalize.
      //    originId pattern set by maybe_create_task is `${forDate}`
      //    for first-compose and `${forDate}:${hash8}` for refresh.
      const taskRows = (await deps.db.execute(sql`
        SELECT id FROM tasks
        WHERE tenant_id = ${ctx.tenantId}
          AND origin_kind IN ('agent-morning-compose', 'agent-compose-refresh')
          AND status != 'done'
          AND (origin_id = ${forDate} OR origin_id LIKE ${`${forDate}:%`})
        ORDER BY created_at DESC
        LIMIT 1
      `)) as unknown as Array<{ id: string }>;
      const taskId = taskRows[0]?.id ?? null;

      if (taskId && deps.toolRegistry) {
        const invokeDeps = {
          registry: deps.toolRegistry,
          db: deps.db as unknown as never,
        };
        const ctxInt: ToolContext = { ...ctx, invokedBy: "internal" };
        try {
          await invoke<unknown, unknown>(
            invokeDeps,
            "framework.comments.post",
            {
              taskId,
              body:
                input.completionComment ??
                `Composed. ${items.length} timeline items, ${input.narrative.length} chars of narrative.`,
            },
            ctxInt,
          );
        } catch (err) {
          phase(
            `write_day_brief: comment failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        try {
          await invoke<unknown, unknown>(
            invokeDeps,
            "framework.tasks.patch",
            { taskId, status: "done" },
            ctxInt,
          );
        } catch (err) {
          phase(
            `write_day_brief: tasks.patch failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      return {
        ok: true,
        result: {
          data: {
            saved: true,
            snapshotId: snapshot.id,
            timelineItemCount: items.length,
            taskFinalized: !!taskId,
            taskId,
          },
        },
      };
    },
  };

  return [maybeCreateTask, prepareMeetingBriefs, daySignal, classifyPending, dayContext, writeMeetingBrief, writeDayBrief];
}
