// Thread excerpt tool — create. Dispatched at
//   /api/tools/executive-assistant.thread_excerpts.create
//
// Verbatim quotes the agent surfaces on a meeting drilldown card.
// The agent reads the meeting's gmail thread (via the framework's
// gmail tooling, scoped to the anchor), picks the highest-signal
// passages, and writes them here. Verbatim — never paraphrased —
// per DESIGN.md §8.

import { z } from "@boringos/module-sdk";
import type { Tool, ToolContext, ToolResult } from "@boringos/module-sdk";
import { and, eq } from "drizzle-orm";
import { threadExcerpts } from "../schema/thread_excerpts.js";
import { meetings } from "../schema/meetings.js";
import type { EaDeps } from "./deps.js";

export function createThreadExcerptTools(deps: EaDeps): Tool[] {
  const create: Tool = {
    name: "thread_excerpts.create",
    description:
      "Record a verbatim excerpt from an email thread on a meeting drilldown. Body is stored as-is (no paraphrasing).",
    inputs: z.object({
      meetingId: z.string().uuid(),
      fromName: z.string().nullable().optional(),
      fromEmail: z.string().nullable().optional(),
      sentAt: z.string().datetime().nullable().optional(),
      body: z.string().min(1),
      sourceMessageId: z.string().nullable().optional(),
      includedInSnapshotId: z.string().uuid().nullable().optional(),
    }),
    async handler(
      input: {
        meetingId: string;
        fromName?: string | null;
        fromEmail?: string | null;
        sentAt?: string | null;
        body: string;
        sourceMessageId?: string | null;
        includedInSnapshotId?: string | null;
      },
      ctx: ToolContext,
    ): Promise<ToolResult> {
      // Tenant guard via the parent meeting.
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
        .insert(threadExcerpts)
        .values({
          meetingId: input.meetingId,
          fromName: input.fromName ?? null,
          fromEmail: input.fromEmail ?? null,
          sentAt: input.sentAt ? new Date(input.sentAt) : null,
          body: input.body,
          sourceMessageId: input.sourceMessageId ?? null,
          includedInSnapshotId: input.includedInSnapshotId ?? null,
        })
        .returning();
      return { ok: true, result: { data: row } };
    },
  };

  return [create];
}
