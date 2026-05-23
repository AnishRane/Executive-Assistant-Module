// Meeting tools — read (list, get) + write (upsert_from_calendar).
// Dispatched at /api/tools/executive-assistant.meetings.<name>.
// tenantId comes from the JWT context; never from input.
//
// upsert_from_calendar is the write path used by the Sync Calendar
// workflow. It is idempotent on (tenant_id, google_event_id) and sets
// last_change_at only when title / start / end actually shifted —
// Phase 4's delta engine will read that signal.

import { z } from "@boringos/module-sdk";
import type { Tool, ToolContext, ToolResult } from "@boringos/module-sdk";
import { eq, and, gte, lte, asc, sql, inArray } from "drizzle-orm";
import { meetings } from "../schema/meetings.js";
import { meetingAttendees } from "../schema/meeting_attendees.js";
import { detectMeetingDelta } from "../services/delta_engine.js";
import { localizeRows } from "../services/tz.js";
import { recomputeConflictsForDate } from "../services/conflict_scan.js";
import { writeFeedback, summariseDiff } from "../services/feedback.js";
import { classify } from "../services/classify.js";
import { invoke } from "@boringos/agent";
import { publishRealtime } from "./deps.js";
import type { EaDeps } from "./deps.js";

export function createMeetingTools(deps: EaDeps): Tool[] {
  const list: Tool = {
    name: "meetings.list",
    description:
      "List meetings for the current tenant within an optional date range, ordered by start time ascending. Each row carries (a) localized time fields (startsAtLocal, endsAtLocal, dayPart, tzAbbr) computed server-side and (b) an `attendees` array with email/name/title/company/bio/isExternal for every external attendee. Use these directly for prose. Do not call meetings.get per row to fetch attendees — they are already here.",
    inputs: z.object({
      startsAfter: z.string().datetime().optional(),
      endsBefore: z.string().datetime().optional(),
      limit: z.number().int().positive().max(500).optional(),
      offset: z.number().int().nonnegative().optional(),
      tz: z.string().optional(),
    }),
    async handler(
      input: {
        startsAfter?: string;
        endsBefore?: string;
        limit?: number;
        offset?: number;
        tz?: string;
      },
      ctx: ToolContext,
    ): Promise<ToolResult> {
      const conds = [eq(meetings.tenantId, ctx.tenantId)];
      if (input.startsAfter) conds.push(gte(meetings.startsAt, new Date(input.startsAfter)));
      if (input.endsBefore) conds.push(lte(meetings.endsAt, new Date(input.endsBefore)));
      const limit = input.limit ?? 50;
      const offset = input.offset ?? 0;
      const rows = await deps.db
        .select()
        .from(meetings)
        .where(and(...conds))
        .orderBy(asc(meetings.startsAt))
        .limit(limit)
        .offset(offset);

      // v0.4.47 — fetch attendees for all meetings in one query and
      // attach per row. Eliminates the N+1 round trip where the agent
      // calls meetings.get per meeting just to read attendees during
      // Day Brief composition.
      const meetingIds = rows.map((r: { id: string }) => r.id);
      const attendeeRows = meetingIds.length > 0
        ? await deps.db
            .select()
            .from(meetingAttendees)
            .where(inArray(meetingAttendees.meetingId, meetingIds))
        : [];
      const attendeesByMeeting = new Map<string, Array<Record<string, unknown>>>();
      for (const a of attendeeRows as Array<{ meetingId: string } & Record<string, unknown>>) {
        const list = attendeesByMeeting.get(a.meetingId);
        if (list) list.push(a);
        else attendeesByMeeting.set(a.meetingId, [a]);
      }

      const localized = await localizeRows(rows, ctx, deps, input.tz);
      const dataWithAttendees = localized.rows.map((r) => ({
        ...r,
        attendees: attendeesByMeeting.get(r.id) ?? [],
      }));

      const tzAnnotation =
        "tz" in localized
          ? { tzIana: localized.tz }
          : { tzError: localized.tzError };
      return {
        ok: true,
        result: {
          data: dataWithAttendees,
          total: dataWithAttendees.length,
          limit,
          offset,
          ...tzAnnotation,
        },
      };
    },
  };

  const get: Tool = {
    name: "meetings.get",
    description:
      "Fetch one meeting by meetingId, including external attendees. Call with { meetingId: '<uuid>' }. Returns localized time fields (startsAtLocal, endsAtLocal, dayPart, tzAbbr) computed server-side from the tenant's configured timezone. Use these for prose, never re-parse the ISO startsAt.",
    inputs: z.object({
      meetingId: z.string().uuid(),
      tz: z.string().optional(),
    }),
    async handler(
      input: { meetingId: string; tz?: string },
      ctx: ToolContext,
    ): Promise<ToolResult> {
      const meetingRow = await deps.db
        .select()
        .from(meetings)
        .where(and(eq(meetings.id, input.meetingId), eq(meetings.tenantId, ctx.tenantId)))
        .limit(1);
      if (!meetingRow.length) {
        return {
          ok: false,
          error: { code: "not_found", message: "Meeting not found", retryable: false },
        };
      }
      const attendees = await deps.db
        .select()
        .from(meetingAttendees)
        .where(eq(meetingAttendees.meetingId, input.meetingId));
      const localized = await localizeRows(meetingRow, ctx, deps, input.tz);
      const tzAnnotation =
        "tz" in localized
          ? { tzIana: localized.tz }
          : { tzError: localized.tzError };
      return {
        ok: true,
        result: {
          data: { ...localized.rows[0], attendees },
          ...tzAnnotation,
        },
      };
    },
  };

  const upsertFromCalendar: Tool = {
    name: "meetings.upsert_from_calendar",
    description:
      "Upsert a meeting from a Google Calendar event. Identified by (tenant_id, google_event_id). Replaces the attendee set on update. Sets last_change_at when title/starts_at/ends_at actually shifted.",
    inputs: z.object({
      googleEventId: z.string(),
      title: z.string(),
      startsAt: z.string().datetime(),
      endsAt: z.string().datetime(),
      location: z.string().nullable().optional(),
      conferenceLink: z.string().nullable().optional(),
      organizerEmail: z.string().nullable().optional(),
      description: z.string().nullable().optional(),
      gmailThreadId: z.string().nullable().optional(),
      attendees: z
        .array(
          z.object({
            email: z.string(),
            name: z.string().nullable().optional(),
            title: z.string().nullable().optional(),
            company: z.string().nullable().optional(),
            isExternal: z.boolean().optional(),
          }),
        )
        .optional(),
    }),
    async handler(
      input: {
        googleEventId: string;
        title: string;
        startsAt: string;
        endsAt: string;
        location?: string | null;
        conferenceLink?: string | null;
        organizerEmail?: string | null;
        description?: string | null;
        gmailThreadId?: string | null;
        attendees?: Array<{
          email: string;
          name?: string | null;
          title?: string | null;
          company?: string | null;
          isExternal?: boolean;
        }>;
      },
      ctx: ToolContext,
    ): Promise<ToolResult> {
      const startsAt = new Date(input.startsAt);
      const endsAt = new Date(input.endsAt);

      const existing = await deps.db
        .select()
        .from(meetings)
        .where(
          and(
            eq(meetings.tenantId, ctx.tenantId),
            eq(meetings.googleEventId, input.googleEventId),
          ),
        )
        .limit(1);

      const isChanged =
        existing.length > 0 &&
        (existing[0]!.startsAt.getTime() !== startsAt.getTime() ||
          existing[0]!.endsAt.getTime() !== endsAt.getTime() ||
          existing[0]!.title !== input.title);

      // v0.4.38 — split the old `INSERT … ON CONFLICT DO UPDATE` into
      // three explicit branches. The point is: when the calendar sync
      // re-feeds an event we already have and nothing about it changed,
      // we write *nothing* to the meetings row. updatedAt stays as it
      // was, no MVCC dead-tuple churn, no spurious "fresh" signal in the
      // row anyone might read. Attendee upsert below still runs because
      // attendee changes can happen without title/time changes.
      let meeting: typeof existing[0];
      if (existing.length === 0) {
        // Fresh insert — never been synced before.
        const [inserted] = await deps.db
          .insert(meetings)
          .values({
            tenantId: ctx.tenantId,
            googleEventId: input.googleEventId,
            title: input.title,
            startsAt,
            endsAt,
            location: input.location ?? null,
            conferenceLink: input.conferenceLink ?? null,
            organizerEmail: input.organizerEmail ?? null,
            description: input.description ?? null,
            gmailThreadId: input.gmailThreadId ?? null,
          })
          .returning();
        meeting = inserted!;
      } else if (isChanged) {
        // Real change — write the new fields + bump updatedAt.
        const [updated] = await deps.db
          .update(meetings)
          .set({
            title: input.title,
            startsAt,
            endsAt,
            location: input.location ?? null,
            conferenceLink: input.conferenceLink ?? null,
            organizerEmail: input.organizerEmail ?? null,
            description: input.description ?? null,
            gmailThreadId: input.gmailThreadId ?? null,
            updatedAt: new Date(),
          })
          .where(eq(meetings.id, existing[0]!.id))
          .returning();
        meeting = updated!;
      } else {
        // No-op — the row is byte-identical to what we'd write.
        // Use the existing row as-is. Zero writes to the meetings table.
        meeting = existing[0]!;
      }

      // Conditional last_change_at — kept as a second query so we
      // never write a "no real change" timestamp the delta engine
      // would later have to filter out.
      if (isChanged) {
        await deps.db
          .update(meetings)
          .set({ lastChangeAt: new Date() })
          .where(eq(meetings.id, meeting!.id));
        // Best-effort: detect deltas + recompute conflicts on
        // any composed snapshot this meeting appears in. Never
        // fail the parent upsert if the engine errors.
        try {
          await detectMeetingDelta(
            deps.db,
            ctx.tenantId,
            meeting!.id,
            { startsAt: existing[0]!.startsAt, endsAt: existing[0]!.endsAt, title: existing[0]!.title },
            { startsAt, endsAt, title: input.title },
          );
        } catch (err) {
          console.warn(
            `[meetings.upsert_from_calendar] delta detection failed:`,
            err instanceof Error ? err.message : err,
          );
        }
      }

      // Attendee replacement: simplest correct strategy. The delta
      // engine in Phase 4 will compare against a snapshot rather than
      // diff at the row layer.
      if (input.attendees) {
        await deps.db
          .delete(meetingAttendees)
          .where(eq(meetingAttendees.meetingId, meeting!.id));
        if (input.attendees.length > 0) {
          await deps.db.insert(meetingAttendees).values(
            input.attendees.map((a) => ({
              meetingId: meeting!.id,
              email: a.email,
              name: a.name ?? null,
              title: a.title ?? null,
              company: a.company ?? null,
              isExternal: a.isExternal ?? true,
            })),
          );
        }
      }

      // v0.4.37: short-circuit the heavy side-effects when this upsert
      // was a no-op. Calendar.sync_window re-upserts every event every
      // minute, and 95% of the time nothing changed — but the prior
      // code still re-ran classify, conflict scan, and realtime publish
      // for each one. /tmp/ea-trace.log: 168 upserts in 3 minutes, all
      // triggering work that didn't matter. Cuts the bulk of the noise.
      const wasNoOp = existing.length > 0 && !isChanged;

      // v0.4.28: classify after attendees are upserted. We only know
      // hasExternalAttendees once the attendees table reflects this
      // event. Skip locked rows (user override is sticky).
      // v0.4.32: read the count from the DB rather than `input.attendees`.
      // The attendees field is optional in the schema; when a re-sync
      // omits it the existing rows are untouched, but the prior code
      // would have inferred zero attendees and reclassified a meeting
      // as task or untagged. Source-of-truth = the attendees table.
      if (!wasNoOp) try {
        const extRows = (await deps.db.execute(sql`
          SELECT count(*)::int AS n
          FROM executive_assistant__meeting_attendees
          WHERE meeting_id = ${meeting!.id} AND is_external = true
        `)) as unknown as Array<{ n: number }>;
        const externalCount = Number(extRows[0]?.n ?? 0);
        const { kind, confidence } = classify({
          title: input.title,
          conferenceLink: input.conferenceLink ?? null,
          location: input.location ?? null,
          hasExternalAttendees: externalCount > 0,
        });
        if (confidence === "high") {
          await deps.db
            .update(meetings)
            .set({ kind })
            .where(
              and(eq(meetings.id, meeting!.id), eq(meetings.kindLocked, false)),
            );
        }
      } catch (err) {
        console.warn(
          `[meetings.upsert_from_calendar] classify failed:`,
          err instanceof Error ? err.message : err,
        );
      }

      // v0.4.14: every upsert recomputes today's conflict set
      // synchronously. No agent dependency, no snapshot involvement.
      // Best-effort: never break the parent upsert.
      // v0.4.37: skip when this was a no-op upsert — conflicts only
      // change when an item's times change, and isChanged covers that.
      const forDate = startsAt.toISOString().slice(0, 10);
      if (!wasNoOp) try {
        await recomputeConflictsForDate(
          deps.db,
          ctx.tenantId,
          forDate,
          deps.getRealtimeBus() ?? undefined,
        );
      } catch (err) {
        console.warn(
          `[ea.meetings.upsert_from_calendar] conflict scan failed:`,
          err instanceof Error ? err.message : err,
        );
      }

      // v0.4.20: publish to realtime bus. Subscribers (admin dashboard,
      // future session-auth-enabled web UI) get notified within ms.
      // v0.4.37: skip on no-op so subscribers don't get spurious
      // "touched" events on every 1-min sync tick.
      if (!wasNoOp) {
        publishRealtime(deps, "executive-assistant:meeting.changed", ctx.tenantId, {
          meetingId: meeting!.id,
          action: existing.length === 0 ? "inserted" : "updated",
          forDate,
        });
      }

      return {
        ok: true,
        result: { data: meeting, isChanged, wasInsert: existing.length === 0 },
      };
    },
  };

  const setBrief: Tool = {
    name: "meetings.set_brief",
    description:
      "Set the brief on a meeting. When the agent calls this (ctx.agentId set), it's the morning-compose write. When a user calls it (ctx.agentId absent), it's an edit — we capture the diff as an edited_brief feedback signal so the reflection step can update david.voice.",
    inputs: z.object({
      meetingId: z.string().uuid(),
      brief: z.string().min(1),
    }),
    async handler(
      input: { meetingId: string; brief: string },
      ctx: ToolContext,
    ): Promise<ToolResult> {
      // Capture the prior brief before writing — needed for the diff
      // payload on a user-initiated edit.
      const prior = await deps.db
        .select({ brief: meetings.brief })
        .from(meetings)
        .where(
          and(eq(meetings.id, input.meetingId), eq(meetings.tenantId, ctx.tenantId)),
        )
        .limit(1);

      const [updated] = await deps.db
        .update(meetings)
        .set({ brief: input.brief, updatedAt: new Date() })
        .where(
          and(eq(meetings.id, input.meetingId), eq(meetings.tenantId, ctx.tenantId)),
        )
        .returning();
      if (!updated) {
        return {
          ok: false,
          error: { code: "not_found", message: "Meeting not found", retryable: false },
        };
      }

      const isUserEdit = !ctx.agentId;
      const priorText = prior[0]?.brief ?? "";
      if (isUserEdit && priorText !== input.brief) {
        const diff = summariseDiff(priorText, input.brief);
        await writeFeedback(deps.db, {
          tenantId: ctx.tenantId,
          signalKind: "edited_brief",
          subjectKind: "meeting",
          subjectId: updated.id,
          value: {
            before: priorText,
            after: input.brief,
            wordsDelta: diff.wordsDelta,
            sentencesDelta: diff.sentencesDelta,
            summary: diff.summary,
          },
          createdByUserId: ctx.wakeOwnerUserId ?? null,
        });
      }

      // v0.4.20: notify subscribers (agent wrote a fresh brief / user edited).
      publishRealtime(deps, "executive-assistant:brief.changed", ctx.tenantId, {
        meetingId: updated.id,
        source: isUserEdit ? "user" : "agent",
      });

      return { ok: true, result: { data: updated } };
    },
  };

  const setNotes: Tool = {
    name: "meetings.set_notes",
    description:
      "Save the user's own notes for a meeting. Distinct from `brief` (the agent's read) — these are user-owned, the agent never overwrites them. Captures an `edited_notes` feedback signal so the reflection step can learn what context the user routinely wants to add.",
    inputs: z.object({
      meetingId: z.string().uuid(),
      notes: z.string(),
    }),
    async handler(
      input: { meetingId: string; notes: string },
      ctx: ToolContext,
    ): Promise<ToolResult> {
      const prior = await deps.db
        .select({ userNotes: meetings.userNotes })
        .from(meetings)
        .where(
          and(eq(meetings.id, input.meetingId), eq(meetings.tenantId, ctx.tenantId)),
        )
        .limit(1);

      const [updated] = await deps.db
        .update(meetings)
        .set({ userNotes: input.notes, updatedAt: new Date() })
        .where(
          and(eq(meetings.id, input.meetingId), eq(meetings.tenantId, ctx.tenantId)),
        )
        .returning();
      if (!updated) {
        return {
          ok: false,
          error: { code: "not_found", message: "Meeting not found", retryable: false },
        };
      }

      const priorText = prior[0]?.userNotes ?? "";
      if (priorText !== input.notes) {
        const diff = summariseDiff(priorText, input.notes);
        await writeFeedback(deps.db, {
          tenantId: ctx.tenantId,
          signalKind: "edited_notes",
          subjectKind: "meeting",
          subjectId: updated.id,
          value: {
            before: priorText,
            after: input.notes,
            wordsDelta: diff.wordsDelta,
            sentencesDelta: diff.sentencesDelta,
            summary: diff.summary,
          },
          createdByUserId: ctx.wakeOwnerUserId ?? null,
        });
      }

      // v0.4.20: notify subscribers of the notes change.
      publishRealtime(deps, "executive-assistant:notes.changed", ctx.tenantId, {
        meetingId: updated.id,
      });

      return { ok: true, result: { data: updated } };
    },
  };

  // v0.4.30 — user override for kind classification. Sets kind +
  // kind_locked=true so the rule classifier and the LLM tagger never
  // overwrite the user's choice.
  // v0.4.31 — also writes a memory note so the LLM tagger can learn
  // the user's preferences over time. Best-effort: memory write
  // failing must not break the override.
  const setKind: Tool = {
    name: "meetings.set_kind",
    description:
      "Override the categorization for a meeting-table row. Sets `kind` to one of meeting/event/task/untagged and locks the row so the classifier never overwrites it. Also writes a memory note that the LLM tagger reads in its prompt, so future similar items lean toward the user's preference.",
    inputs: z.object({
      meetingId: z.string().uuid(),
      kind: z.enum(["meeting", "event", "task", "untagged"]),
    }),
    async handler(
      input: { meetingId: string; kind: "meeting" | "event" | "task" | "untagged" },
      ctx: ToolContext,
    ): Promise<ToolResult> {
      // Pull a tiny snapshot of the row before update so the memory
      // note has enough context for the LLM tagger to generalize.
      const prior = await deps.db
        .select({
          title: meetings.title,
          location: meetings.location,
          conferenceLink: meetings.conferenceLink,
          kind: meetings.kind,
        })
        .from(meetings)
        .where(
          and(
            eq(meetings.id, input.meetingId),
            eq(meetings.tenantId, ctx.tenantId),
          ),
        )
        .limit(1);

      const [updated] = await deps.db
        .update(meetings)
        .set({
          kind: input.kind,
          kindLocked: true,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(meetings.id, input.meetingId),
            eq(meetings.tenantId, ctx.tenantId),
          ),
        )
        .returning();
      if (!updated) {
        return {
          ok: false,
          error: {
            code: "not_found",
            message: "Meeting not found",
            retryable: false,
          },
        };
      }

      publishRealtime(deps, "executive-assistant:kind.changed", ctx.tenantId, {
        meetingId: updated.id,
        kind: input.kind,
      });

      // v0.4.31: memory note for the LLM tagger to learn from. Skip
      // the write when the override is a no-op (same kind as before).
      const priorRow = prior[0];
      if (priorRow && priorRow.kind !== input.kind && deps.toolRegistry) {
        const summary = summarizeForMemory(priorRow, input.kind);
        try {
          await invoke(
            { registry: deps.toolRegistry, db: deps.db as unknown as never },
            "memory.remember",
            {
              content: summary,
              tags: ["user.kind_preference"],
            },
            { ...ctx, invokedBy: "internal" },
          );
        } catch (err) {
          console.warn(
            `[meetings.set_kind] memory.remember failed:`,
            err instanceof Error ? err.message : err,
          );
        }
      }

      return { ok: true, result: { data: updated } };
    },
  };

  // v0.4.31 — read-side for the LLM tagger workflow. Filtered to
  // kind='untagged' AND kind_locked=false. Includes external-attendees
  // count so the prompt has everything the rule had.
  const listUntagged: Tool = {
    name: "meetings.list_untagged",
    description:
      "List meeting-table rows that are still 'untagged' and not locked by a user override. Used by the LLM tagger workflow to find items the rule classifier couldn't commit on. Each row includes title, location, conferenceLink, and external-attendee count.",
    inputs: z.object({
      limit: z.number().int().positive().max(50).optional(),
    }),
    async handler(
      input: { limit?: number },
      ctx: ToolContext,
    ): Promise<ToolResult> {
      const limit = input.limit ?? 20;
      const rows = await deps.db.execute(sql`
        SELECT m.id, m.title, m.location, m.conference_link,
               COALESCE((
                 SELECT count(*)::int FROM executive_assistant__meeting_attendees a
                 WHERE a.meeting_id = m.id AND a.is_external = true
               ), 0) AS external_attendees
        FROM executive_assistant__meetings m
        WHERE m.tenant_id = ${ctx.tenantId}
          AND m.kind = 'untagged'
          AND m.kind_locked = false
        ORDER BY m.starts_at ASC
        LIMIT ${limit}
      `);
      type R = {
        id: string;
        title: string;
        location: string | null;
        conference_link: string | null;
        external_attendees: number;
      };
      const data = (rows as unknown as R[]).map((r) => ({
        id: r.id,
        title: r.title,
        location: r.location,
        conferenceLink: r.conference_link,
        externalAttendees: Number(r.external_attendees),
      }));
      return { ok: true, result: { data, total: data.length } };
    },
  };

  // v0.4.31 — LLM tagger write path. Sets kind without locking the
  // row, so future user overrides still take precedence. Respects an
  // existing user lock (never overwrites kind_locked = true).
  const classifySetKind: Tool = {
    name: "meetings.classify_set_kind",
    description:
      "LLM tagger writes the resolved kind here. Sets kind WITHOUT locking; the user override path uses set_kind to lock. Skips the write if the row is already user-locked.",
    inputs: z.object({
      meetingId: z.string().uuid(),
      kind: z.enum(["meeting", "event", "task"]),
    }),
    async handler(
      input: { meetingId: string; kind: "meeting" | "event" | "task" },
      ctx: ToolContext,
    ): Promise<ToolResult> {
      const [updated] = await deps.db
        .update(meetings)
        .set({ kind: input.kind, updatedAt: new Date() })
        .where(
          and(
            eq(meetings.id, input.meetingId),
            eq(meetings.tenantId, ctx.tenantId),
            eq(meetings.kindLocked, false),
          ),
        )
        .returning();
      if (!updated) {
        return {
          ok: true,
          result: { data: { skipped: true, reason: "not_found_or_locked" } },
        };
      }
      publishRealtime(deps, "executive-assistant:kind.changed", ctx.tenantId, {
        meetingId: updated.id,
        kind: input.kind,
      });
      return { ok: true, result: { data: updated } };
    },
  };

  return [
    list,
    get,
    upsertFromCalendar,
    setBrief,
    setNotes,
    setKind,
    listUntagged,
    classifySetKind,
  ];
}

// ─── helpers ─────────────────────────────────────────────────────

// Compose a one-line memory note that the LLM tagger can read later.
// Keeps it factual and pattern-oriented so a single override
// generalizes across similar items.
function summarizeForMemory(
  prior: { title: string; location: string | null; conferenceLink: string | null; kind: string },
  next: string,
): string {
  const features: string[] = [];
  features.push(`titled "${prior.title}"`);
  if (prior.location) features.push(`at "${prior.location}"`);
  if (prior.conferenceLink) features.push("with a video link");
  else features.push("no video link");
  return `When an item ${features.join(", ")} appears, the user prefers kind '${next}' over '${prior.kind}'. Apply this pattern to similar items.`;
}
