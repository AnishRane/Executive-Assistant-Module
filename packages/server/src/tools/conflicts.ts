// Conflict tools (v0.4.14 rewrite).
//
// Conflicts are now keyed by (tenant_id, for_date, ref_a_id, ref_b_id).
// No snapshot or timeline_item involvement. The scan runs server-side
// on every calendar mutation — see services/conflict_scan.ts.

import { z } from "@boringos/module-sdk";
import type { Tool, ToolContext, ToolResult } from "@boringos/module-sdk";
import { eq, and, ne } from "drizzle-orm";
import { conflicts } from "../schema/conflicts.js";
import { writeFeedback } from "../services/feedback.js";
import { recomputeConflictsForDate } from "../services/conflict_scan.js";
import type { EaDeps } from "./deps.js";

export function createConflictTools(deps: EaDeps): Tool[] {
  const list: Tool = {
    name: "conflicts.list",
    description:
      "List conflicts for a given date. By default returns only unresolved + acknowledged ones (auto_resolved + resolved_by_user filtered out).",
    inputs: z.object({
      forDate: z.string().date(),
      includeResolved: z.boolean().optional(),
    }),
    async handler(
      input: { forDate: string; includeResolved?: boolean },
      ctx: ToolContext,
    ): Promise<ToolResult> {
      const conds = [
        eq(conflicts.tenantId, ctx.tenantId),
        eq(conflicts.forDate, input.forDate),
      ];
      if (!input.includeResolved) {
        conds.push(ne(conflicts.resolutionStatus, "auto_resolved"));
        conds.push(ne(conflicts.resolutionStatus, "resolved_by_user"));
      }
      const rows = await deps.db
        .select()
        .from(conflicts)
        .where(and(...conds));
      return { ok: true, result: { data: rows, total: rows.length } };
    },
  };

  const resolve: Tool = {
    name: "conflicts.resolve",
    description:
      "Resolve a conflict. Two paths: (1) chosenRefId set → user picked that side; emits a conflict_resolved feedback signal. (2) chosenRefId omitted → user attended neither (or got pulled elsewhere); emits a conflict_both_skipped feedback signal. Either way sets resolution_status='resolved_by_user'.",
    inputs: z.object({
      id: z.string().uuid(),
      chosenRefId: z.string().uuid().optional(),
    }),
    async handler(
      input: { id: string; chosenRefId?: string },
      ctx: ToolContext,
    ): Promise<ToolResult> {
      const found = await deps.db
        .select()
        .from(conflicts)
        .where(
          and(eq(conflicts.id, input.id), eq(conflicts.tenantId, ctx.tenantId)),
        )
        .limit(1);
      if (!found.length) {
        return {
          ok: false,
          error: { code: "not_found", message: "Conflict not found", retryable: false },
        };
      }
      const c = found[0]!;
      if (
        input.chosenRefId &&
        c.refAId !== input.chosenRefId &&
        c.refBId !== input.chosenRefId
      ) {
        return {
          ok: false,
          error: {
            code: "invalid_input",
            message: "Chosen ref must be one of the two on the conflict.",
            retryable: false,
          },
        };
      }
      const [updated] = await deps.db
        .update(conflicts)
        .set({
          resolutionStatus: "resolved_by_user",
          resolvedChoice: input.chosenRefId ?? null,
        })
        .where(eq(conflicts.id, input.id))
        .returning();

      if (input.chosenRefId) {
        await writeFeedback(deps.db, {
          tenantId: ctx.tenantId,
          signalKind: "conflict_resolved",
          subjectKind: "conflict",
          subjectId: updated!.id,
          value: {
            chosenRefId: input.chosenRefId,
            deprioritisedRefId:
              c.refAId === input.chosenRefId ? c.refBId : c.refAId,
            overlapMinutes: c.overlapMinutes,
          },
          createdByUserId: ctx.wakeOwnerUserId ?? null,
        });
      } else {
        await writeFeedback(deps.db, {
          tenantId: ctx.tenantId,
          signalKind: "conflict_both_skipped",
          subjectKind: "conflict",
          subjectId: updated!.id,
          value: {
            refAKind: c.refAKind,
            refAId: c.refAId,
            refBKind: c.refBKind,
            refBId: c.refBId,
            overlapMinutes: c.overlapMinutes,
          },
          createdByUserId: ctx.wakeOwnerUserId ?? null,
        });
      }

      return { ok: true, result: { data: updated } };
    },
  };

  const recomputeForDate: Tool = {
    name: "conflicts.recompute_for_date",
    description:
      "Manually trigger a conflict scan for a given date. Normally not needed (scans run automatically on every calendar mutation), but useful for the UI to fire after a fresh install or as a safety net.",
    inputs: z.object({ forDate: z.string().date() }),
    async handler(
      input: { forDate: string },
      ctx: ToolContext,
    ): Promise<ToolResult> {
      try {
        await recomputeConflictsForDate(
          deps.db,
          ctx.tenantId,
          input.forDate,
          deps.getRealtimeBus() ?? undefined,
        );
        return {
          ok: true,
          result: { data: { forDate: input.forDate, recomputed: true } },
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(
          `[ea.conflicts.recompute_for_date] failed for ${input.forDate}: ${message}`,
        );
        return {
          ok: true,
          result: {
            data: { forDate: input.forDate, recomputed: false, error: message },
          },
        };
      }
    },
  };

  return [list, resolve, recomputeForDate];
}
