// Feedback signal tools — generic record + list.
//
// Most affordances flow through domain-specific tools that wrap a
// write of their own + a feedback row (action_items.dismiss,
// conflicts.resolve, meetings.set_brief when user-initiated, etc.).
// This generic surface exists for:
//   - the agent's reflection step to log opened_card / acknowledged_delta
//     telemetry
//   - future affordances (pin_thread, edit_attendee_bio) that don't
//     yet have a domain wrapper
//   - the Memory & evidence UI page to read recent signals

import { z } from "@boringos/module-sdk";
import type { Tool, ToolContext, ToolResult } from "@boringos/module-sdk";
import { eq, and, desc } from "drizzle-orm";
import { feedbackSignals } from "../schema/feedback_signals.js";
import { writeFeedback } from "../services/feedback.js";
import type { EaDeps } from "./deps.js";

const SIGNAL_KINDS = [
  "edited_brief",
  "edited_attendee_bio",
  "pinned_thread",
  "dismissed_action",
  "marked_unhelpful",
  "conflict_resolved",
  "opened_card",
  "acknowledged_delta",
  "dismissed_suggestion",
  "weather_dismissed",
  "weather_too_detailed",
  "weather_too_terse",
] as const;

const SUBJECT_KINDS = [
  "meeting",
  "trip_leg",
  "snapshot",
  "delta",
  "action_item",
  "conflict",
  "attendee",
  "weather",
] as const;

export function createFeedbackSignalTools(deps: EaDeps): Tool[] {
  const record: Tool = {
    name: "feedback_signals.record",
    description:
      "Record a feedback signal. Generic write surface — most domain affordances have their own wrapper tool that calls this internally.",
    inputs: z.object({
      signalKind: z.enum(SIGNAL_KINDS),
      subjectKind: z.enum(SUBJECT_KINDS),
      subjectId: z.string().uuid(),
      value: z.record(z.unknown()).optional(),
    }),
    async handler(
      input: {
        signalKind: (typeof SIGNAL_KINDS)[number];
        subjectKind: (typeof SUBJECT_KINDS)[number];
        subjectId: string;
        value?: Record<string, unknown>;
      },
      ctx: ToolContext,
    ): Promise<ToolResult> {
      await writeFeedback(deps.db, {
        tenantId: ctx.tenantId,
        signalKind: input.signalKind,
        subjectKind: input.subjectKind,
        subjectId: input.subjectId,
        value: input.value ?? {},
        createdByUserId: ctx.wakeOwnerUserId ?? null,
      });
      return { ok: true, result: { data: { recorded: true } } };
    },
  };

  const list: Tool = {
    name: "feedback_signals.list",
    description:
      "List recent feedback signals for the current tenant, most recent first. Optionally filter by signalKind or subjectKind.",
    inputs: z.object({
      signalKind: z.enum(SIGNAL_KINDS).optional(),
      subjectKind: z.enum(SUBJECT_KINDS).optional(),
      limit: z.number().int().positive().max(500).optional(),
      offset: z.number().int().nonnegative().optional(),
    }),
    async handler(
      input: {
        signalKind?: (typeof SIGNAL_KINDS)[number];
        subjectKind?: (typeof SUBJECT_KINDS)[number];
        limit?: number;
        offset?: number;
      },
      ctx: ToolContext,
    ): Promise<ToolResult> {
      const conds = [eq(feedbackSignals.tenantId, ctx.tenantId)];
      if (input.signalKind) conds.push(eq(feedbackSignals.signalKind, input.signalKind));
      if (input.subjectKind) conds.push(eq(feedbackSignals.subjectKind, input.subjectKind));
      const limit = input.limit ?? 100;
      const offset = input.offset ?? 0;
      const rows = await deps.db
        .select()
        .from(feedbackSignals)
        .where(and(...conds))
        .orderBy(desc(feedbackSignals.createdAt))
        .limit(limit)
        .offset(offset);
      return {
        ok: true,
        result: { data: rows, total: rows.length, limit, offset },
      };
    },
  };

  return [record, list];
}
