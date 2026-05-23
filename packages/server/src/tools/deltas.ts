// Delta tools — list (UI fetches per-snapshot) and acknowledge
// (UI marks "I've seen this" to fade the visual cue).
// Detection of deltas happens in the delta_engine service, called
// from the write tools. This file is the read + ack surface.

import { z } from "@boringos/module-sdk";
import type { Tool, ToolContext, ToolResult } from "@boringos/module-sdk";
import { eq, and, isNull, sql, asc, desc } from "drizzle-orm";
import { deltas } from "../schema/deltas.js";
import { snapshots } from "../schema/snapshots.js";
import { writeFeedback } from "../services/feedback.js";
import type { EaDeps } from "./deps.js";

export function createDeltaTools(deps: EaDeps): Tool[] {
  const list: Tool = {
    name: "deltas.list",
    description:
      "List deltas for a snapshot. By default returns unacknowledged ones; pass includeAcknowledged: true to see all.",
    inputs: z.object({
      snapshotId: z.string().uuid(),
      includeAcknowledged: z.boolean().optional(),
      limit: z.number().int().positive().max(500).optional(),
    }),
    async handler(
      input: {
        snapshotId: string;
        includeAcknowledged?: boolean;
        limit?: number;
      },
      ctx: ToolContext,
    ): Promise<ToolResult> {
      // Tenant guard via the parent snapshot.
      const owner = await deps.db
        .select({ id: snapshots.id })
        .from(snapshots)
        .where(
          and(eq(snapshots.id, input.snapshotId), eq(snapshots.tenantId, ctx.tenantId)),
        )
        .limit(1);
      if (!owner.length) {
        return {
          ok: false,
          error: { code: "not_found", message: "Snapshot not found", retryable: false },
        };
      }

      const conds = [eq(deltas.snapshotId, input.snapshotId)];
      if (!input.includeAcknowledged) {
        conds.push(isNull(deltas.acknowledgedAt));
      }
      const rows = await deps.db
        .select()
        .from(deltas)
        .where(and(...conds))
        .orderBy(desc(deltas.occurredAt))
        .limit(input.limit ?? 100);
      return {
        ok: true,
        result: { data: rows, total: rows.length },
      };
    },
  };

  const acknowledge: Tool = {
    name: "deltas.acknowledge",
    description:
      "Mark a delta as acknowledged. Fades the 'changed since you last looked' visual cue. Idempotent.",
    inputs: z.object({ id: z.string().uuid() }),
    async handler(
      input: { id: string },
      ctx: ToolContext,
    ): Promise<ToolResult> {
      const [updated] = await deps.db
        .update(deltas)
        .set({ acknowledgedAt: new Date() })
        .where(
          sql`${deltas.id} = ${input.id}::uuid AND EXISTS (
            SELECT 1 FROM executive_assistant__snapshots s
            WHERE s.id = ${deltas.snapshotId} AND s.tenant_id = ${ctx.tenantId}
          )`,
        )
        .returning();
      if (!updated) {
        return {
          ok: false,
          error: { code: "not_found", message: "Delta not found", retryable: false },
        };
      }
      return { ok: true, result: { data: updated } };
    },
  };

  const markUnhelpful: Tool = {
    name: "deltas.mark_unhelpful",
    description:
      "Record that David finds this delta not worth elevating (the 'Less of this' affordance). Writes a marked_unhelpful feedback row; the reflection step uses these to tune the elevation policy.",
    inputs: z.object({ id: z.string().uuid() }),
    async handler(
      input: { id: string },
      ctx: ToolContext,
    ): Promise<ToolResult> {
      // Tenant guard via parent snapshot.
      const owner = await deps.db
        .select({ id: deltas.id, kind: deltas.deltaKind })
        .from(deltas)
        .innerJoin(snapshots, eq(snapshots.id, deltas.snapshotId))
        .where(and(eq(deltas.id, input.id), eq(snapshots.tenantId, ctx.tenantId)))
        .limit(1);
      if (!owner.length) {
        return {
          ok: false,
          error: { code: "not_found", message: "Delta not found", retryable: false },
        };
      }

      await writeFeedback(deps.db, {
        tenantId: ctx.tenantId,
        signalKind: "marked_unhelpful",
        subjectKind: "delta",
        subjectId: input.id,
        value: { deltaKind: owner[0]!.kind },
        createdByUserId: ctx.wakeOwnerUserId ?? null,
      });
      return { ok: true, result: { data: { marked: true } } };
    },
  };

  // Silence "unused imports" if we tighten signatures later.
  void asc;

  return [list, acknowledge, markUnhelpful];
}
