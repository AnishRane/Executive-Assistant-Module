// Read-only trip tools — list / get. Dispatched at
//   /api/tools/executive-assistant.trips.<name>
// tenantId comes from the JWT context.
//
// Phase 1a: read-only. Phase 1b adds trip_legs.reconcile_from_email
// (called by the sync_email_anchors workflow).

import { z } from "@boringos/module-sdk";
import type { Tool, ToolContext, ToolResult } from "@boringos/module-sdk";
import { eq, and, gte, lte, asc } from "drizzle-orm";
import { trips } from "../schema/trips.js";
import { tripLegs } from "../schema/trip_legs.js";
import { localizeTimes, resolveTenantTz } from "../services/tz.js";
import type { EaDeps } from "./deps.js";

export function createTripTools(deps: EaDeps): Tool[] {
  const list: Tool = {
    name: "trips.list",
    description:
      "List trips for the current tenant within an optional date range, ordered by start date ascending.",
    inputs: z.object({
      startsAfter: z.string().date().optional(),
      endsBefore: z.string().date().optional(),
      status: z.enum(["planned", "in_progress", "completed", "all"]).optional(),
      limit: z.number().int().positive().max(500).optional(),
      offset: z.number().int().nonnegative().optional(),
    }),
    async handler(
      input: {
        startsAfter?: string;
        endsBefore?: string;
        status?: "planned" | "in_progress" | "completed" | "all";
        limit?: number;
        offset?: number;
      },
      ctx: ToolContext,
    ): Promise<ToolResult> {
      const conds = [eq(trips.tenantId, ctx.tenantId)];
      if (input.startsAfter) conds.push(gte(trips.startsOn, input.startsAfter));
      if (input.endsBefore) conds.push(lte(trips.endsOn, input.endsBefore));
      if (input.status && input.status !== "all") {
        conds.push(eq(trips.status, input.status));
      }
      const limit = input.limit ?? 50;
      const offset = input.offset ?? 0;
      const rows = await deps.db
        .select()
        .from(trips)
        .where(and(...conds))
        .orderBy(asc(trips.startsOn))
        .limit(limit)
        .offset(offset);
      return {
        ok: true,
        result: { data: rows, total: rows.length, limit, offset },
      };
    },
  };

  const get: Tool = {
    name: "trips.get",
    description: "Fetch one trip by id, including its legs in chronological order.",
    inputs: z.object({ id: z.string().uuid() }),
    async handler(
      input: { id: string },
      ctx: ToolContext,
    ): Promise<ToolResult> {
      const tripRow = await deps.db
        .select()
        .from(trips)
        .where(and(eq(trips.id, input.id), eq(trips.tenantId, ctx.tenantId)))
        .limit(1);
      if (!tripRow.length) {
        return {
          ok: false,
          error: { code: "not_found", message: "Trip not found", retryable: false },
        };
      }
      const legs = await deps.db
        .select()
        .from(tripLegs)
        .where(eq(tripLegs.tripId, input.id))
        .orderBy(asc(tripLegs.startsAt));

      // v0.4.26: localize legs that have startsAt. trip_legs.startsAt
      // is nullable (one-way bookings without inbound time, for
      // example) so we can't use localizeRows directly. Inline map.
      const tzResult = await resolveTenantTz(ctx, deps);
      const tz = "tz" in tzResult ? tzResult.tz : null;
      const localizedLegs = legs.map((leg) => {
        if (tz && leg.startsAt) {
          return {
            ...leg,
            ...localizeTimes(
              { startsAt: leg.startsAt, endsAt: leg.endsAt },
              tz,
            ),
          };
        }
        return leg;
      });

      const tzAnnotation =
        "tz" in tzResult
          ? { tzIana: tzResult.tz }
          : { tzError: tzResult.error };

      return {
        ok: true,
        result: { data: { ...tripRow[0], legs: localizedLegs }, ...tzAnnotation },
      };
    },
  };

  return [list, get];
}
