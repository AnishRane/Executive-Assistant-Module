// Action item tool — create. Dispatched at
//   /api/tools/executive-assistant.action_items.create
//
// "Klein still owes you the term sheet." "You promised Patel an
// intro by Friday." The agent extracts these from a meeting's thread
// during morning compose. status defaults to 'open' — David's
// dismissals in the UI flip it to 'ignored' (Phase 5 wires the
// dismiss affordance to feedback_signals).

import { z } from "@boringos/module-sdk";
import type { Tool, ToolContext, ToolResult } from "@boringos/module-sdk";
import { and, eq } from "drizzle-orm";
import { actionItems } from "../schema/action_items.js";
import { meetings } from "../schema/meetings.js";
import { writeFeedback } from "../services/feedback.js";
import type { EaDeps } from "./deps.js";

export function createActionItemTools(deps: EaDeps): Tool[] {
  const create: Tool = {
    name: "action_items.create",
    description:
      "Record an inferred open action item for a meeting. Call with { meetingId: '<uuid>', owedBy: 'user' | '<email>', text: '<what is owed>', status?: 'open' }. owedBy is the literal string 'user' if the action sits with the user, otherwise the external party's email address.",
    inputs: z.object({
      meetingId: z.string().uuid(),
      owedBy: z.string().min(1),
      text: z.string().min(1),
      status: z.enum(["open", "resolved", "ignored"]).optional(),
      sourceMessageId: z.string().nullable().optional(),
    }),
    async handler(
      input: {
        meetingId: string;
        owedBy: string;
        text: string;
        status?: "open" | "resolved" | "ignored";
        sourceMessageId?: string | null;
      },
      ctx: ToolContext,
    ): Promise<ToolResult> {
      const meetingOwner = await deps.db
        .select({ id: meetings.id })
        .from(meetings)
        .where(
          and(
            eq(meetings.id, input.meetingId),
            eq(meetings.tenantId, ctx.tenantId),
          ),
        )
        .limit(1);
      if (!meetingOwner.length) {
        return {
          ok: false,
          error: {
            code: "not_found",
            message: "Meeting not found in current tenant.",
            retryable: false,
          },
        };
      }

      const [row] = await deps.db
        .insert(actionItems)
        .values({
          meetingId: input.meetingId,
          owedBy: input.owedBy,
          text: input.text,
          status: input.status ?? "open",
          sourceMessageId: input.sourceMessageId ?? null,
        })
        .returning();
      return { ok: true, result: { data: row } };
    },
  };

  const dismiss: Tool = {
    name: "action_items.dismiss",
    description:
      "Dismiss an inferred action item — David marking it as not actually owed. Flips status to 'ignored' and records a dismissed_action feedback signal that calibrates how cautious the agent's extractor is.",
    inputs: z.object({ id: z.string().uuid() }),
    async handler(
      input: { id: string },
      ctx: ToolContext,
    ): Promise<ToolResult> {
      // Tenant guard via the parent meeting on the row.
      const owner = await deps.db
        .select({ id: actionItems.id, meetingId: actionItems.meetingId })
        .from(actionItems)
        .innerJoin(meetings, eq(meetings.id, actionItems.meetingId))
        .where(
          and(eq(actionItems.id, input.id), eq(meetings.tenantId, ctx.tenantId)),
        )
        .limit(1);
      if (!owner.length) {
        return {
          ok: false,
          error: { code: "not_found", message: "Action item not found", retryable: false },
        };
      }

      const [updated] = await deps.db
        .update(actionItems)
        .set({ status: "ignored", updatedAt: new Date() })
        .where(eq(actionItems.id, input.id))
        .returning();

      await writeFeedback(deps.db, {
        tenantId: ctx.tenantId,
        signalKind: "dismissed_action",
        subjectKind: "action_item",
        subjectId: input.id,
        value: { text: updated!.text, owedBy: updated!.owedBy },
        createdByUserId: ctx.wakeOwnerUserId ?? null,
      });

      return { ok: true, result: { data: updated } };
    },
  };

  return [create, dismiss];
}
