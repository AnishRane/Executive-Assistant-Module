// OOO window tools — read (list) + write (upsert_from_calendar).
// Dispatched at /api/tools/executive-assistant.ooo.<name>.

import { z } from "@boringos/module-sdk";
import type { Tool, ToolContext, ToolResult } from "@boringos/module-sdk";
import { eq, and, gte, lte, asc } from "drizzle-orm";
import { oooWindows } from "../schema/ooo_windows.js";
import { detectOooDelta } from "../services/delta_engine.js";
import { recomputeConflictsForDate } from "../services/conflict_scan.js";
import { localizeRows } from "../services/tz.js";
import type { EaDeps } from "./deps.js";

export function createOooTools(deps: EaDeps): Tool[] {
  const list: Tool = {
    name: "ooo.list",
    description:
      "List out-of-office windows for the current tenant. Each row carries server-localized time fields (startsAtLocal, endsAtLocal, dayPart, tzAbbr). Use these in prose; never re-parse the raw ISO startsAt.",
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
      const conds = [eq(oooWindows.tenantId, ctx.tenantId)];
      if (input.startsAfter) conds.push(gte(oooWindows.startsAt, new Date(input.startsAfter)));
      if (input.endsBefore) conds.push(lte(oooWindows.endsAt, new Date(input.endsBefore)));
      const limit = input.limit ?? 50;
      const offset = input.offset ?? 0;
      const rows = await deps.db
        .select()
        .from(oooWindows)
        .where(and(...conds))
        .orderBy(asc(oooWindows.startsAt))
        .limit(limit)
        .offset(offset);
      const localized = await localizeRows(rows, ctx, deps, input.tz);
      const tzAnnotation =
        "tz" in localized
          ? { tzIana: localized.tz }
          : { tzError: localized.tzError };
      return {
        ok: true,
        result: {
          data: localized.rows,
          total: localized.rows.length,
          limit,
          offset,
          ...tzAnnotation,
        },
      };
    },
  };

  const upsertFromCalendar: Tool = {
    name: "ooo.upsert_from_calendar",
    description:
      "Upsert an OOO window from an OOO-typed Google Calendar event. Identified by (tenant_id, source_ref_id) when source='calendar_event'.",
    inputs: z.object({
      sourceRefId: z.string(),
      startsAt: z.string().datetime(),
      endsAt: z.string().datetime(),
      label: z.string().nullable().optional(),
    }),
    async handler(
      input: {
        sourceRefId: string;
        startsAt: string;
        endsAt: string;
        label?: string | null;
      },
      ctx: ToolContext,
    ): Promise<ToolResult> {
      // SELECT-then-INSERT/UPDATE: the unique constraint on ooo_windows
      // is *partial* (only when source='calendar_event' AND source_ref_id IS NOT NULL),
      // so Drizzle's onConflictDoUpdate can't target it without a custom
      // ON CONFLICT clause. Two-query path is clear and the routine is
      // single-process so the race window is irrelevant.
      const existing = await deps.db
        .select()
        .from(oooWindows)
        .where(
          and(
            eq(oooWindows.tenantId, ctx.tenantId),
            eq(oooWindows.source, "calendar_event"),
            eq(oooWindows.sourceRefId, input.sourceRefId),
          ),
        )
        .limit(1);

      if (existing.length > 0) {
        const newStartsAt = new Date(input.startsAt);
        const newEndsAt = new Date(input.endsAt);
        const [updated] = await deps.db
          .update(oooWindows)
          .set({
            startsAt: newStartsAt,
            endsAt: newEndsAt,
            label: input.label ?? null,
            updatedAt: new Date(),
          })
          .where(eq(oooWindows.id, existing[0]!.id))
          .returning();
        try {
          await detectOooDelta(
            deps.db,
            ctx.tenantId,
            updated!.id,
            { startsAt: existing[0]!.startsAt, endsAt: existing[0]!.endsAt },
            { startsAt: newStartsAt, endsAt: newEndsAt },
          );
        } catch (err) {
          console.warn(
            `[ooo.upsert_from_calendar] delta detection failed:`,
            err instanceof Error ? err.message : err,
          );
        }
        // v0.4.14: recompute conflicts for the day after every upsert.
        try {
          const forDate = newStartsAt.toISOString().slice(0, 10);
          await recomputeConflictsForDate(
            deps.db,
            ctx.tenantId,
            forDate,
            deps.getRealtimeBus() ?? undefined,
          );
        } catch (err) {
          console.warn(
            `[ooo.upsert_from_calendar] conflict scan failed:`,
            err instanceof Error ? err.message : err,
          );
        }
        return { ok: true, result: { data: updated, wasInsert: false } };
      }

      const [inserted] = await deps.db
        .insert(oooWindows)
        .values({
          tenantId: ctx.tenantId,
          source: "calendar_event",
          sourceRefId: input.sourceRefId,
          startsAt: new Date(input.startsAt),
          endsAt: new Date(input.endsAt),
          label: input.label ?? null,
        })
        .returning();

      // v0.4.14: recompute conflicts on insert too.
      try {
        const forDate = new Date(input.startsAt).toISOString().slice(0, 10);
        await recomputeConflictsForDate(
            deps.db,
            ctx.tenantId,
            forDate,
            deps.getRealtimeBus() ?? undefined,
          );
      } catch (err) {
        console.warn(
          `[ooo.upsert_from_calendar] conflict scan failed:`,
          err instanceof Error ? err.message : err,
        );
      }

      return { ok: true, result: { data: inserted, wasInsert: true } };
    },
  };

  return [list, upsertFromCalendar];
}
