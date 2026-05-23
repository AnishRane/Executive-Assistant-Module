// Timeline item tool — create. Dispatched at
//   /api/tools/executive-assistant.timeline_items.create
//
// The agent calls this after snapshots.create to populate the day's
// timeline. Each row points at one underlying entity (meeting,
// trip_leg, or ooo_window) via (kind, ref_id) — see DESIGN.md §4.

import { z } from "@boringos/module-sdk";
import type { Tool, ToolContext, ToolResult } from "@boringos/module-sdk";
import { and, eq, asc } from "drizzle-orm";
import { timelineItems } from "../schema/timeline_items.js";
import { snapshots } from "../schema/snapshots.js";
import { meetings } from "../schema/meetings.js";
import { oooWindows } from "../schema/ooo_windows.js";
import { tripLegs } from "../schema/trip_legs.js";
import type { EaDeps } from "./deps.js";

export function createTimelineItemTools(deps: EaDeps): Tool[] {
  const list: Tool = {
    name: "timeline_items.list",
    description:
      "List a snapshot's timeline items ordered by starts_at. Returns raw rows; UI joins with meetings/trips/ooo for display.",
    inputs: z.object({ snapshotId: z.string().uuid() }),
    async handler(
      input: { snapshotId: string },
      ctx: ToolContext,
    ): Promise<ToolResult> {
      const owner = await deps.db
        .select({ id: snapshots.id })
        .from(snapshots)
        .where(
          and(
            eq(snapshots.id, input.snapshotId),
            eq(snapshots.tenantId, ctx.tenantId),
          ),
        )
        .limit(1);
      if (!owner.length) {
        return {
          ok: false,
          error: { code: "not_found", message: "Snapshot not found", retryable: false },
        };
      }
      const rows = await deps.db
        .select()
        .from(timelineItems)
        .where(eq(timelineItems.snapshotId, input.snapshotId))
        .orderBy(asc(timelineItems.startsAt));
      return { ok: true, result: { data: rows, total: rows.length } };
    },
  };

  const create: Tool = {
    name: "timeline_items.create",
    description:
      "Append an entry to a snapshot's timeline. kind discriminates which table ref_id points at (meeting | trip_leg | ooo).",
    inputs: z.object({
      snapshotId: z.string().uuid(),
      kind: z.enum(["meeting", "trip_leg", "ooo"]),
      refId: z.string().uuid(),
      // startsAt + endsAt are optional (v0.4.12) — the server
      // denormalizes from the underlying entity when omitted. The
      // agent CAN still pass them explicitly to override.
      startsAt: z.string().datetime().optional(),
      endsAt: z.string().datetime().nullable().optional(),
      elevated: z.boolean().optional(),
      elevationReason: z
        .enum(["imminent", "changed", "agent_flag"])
        .nullable()
        .optional(),
      sortOrder: z.number().int().optional(),
    }),
    async handler(
      input: {
        snapshotId: string;
        kind: "meeting" | "trip_leg" | "ooo";
        refId: string;
        startsAt?: string;
        endsAt?: string | null;
        elevated?: boolean;
        elevationReason?: "imminent" | "changed" | "agent_flag" | null;
        sortOrder?: number;
      },
      ctx: ToolContext,
    ): Promise<ToolResult> {
      // Tenant guard: ensure the snapshot belongs to this tenant. Without
      // this, an agent in tenant A could (in principle) write to tenant B's
      // timeline. The JWT-derived tenantId is the authority.
      const snapshotOwner = await deps.db
        .select({ id: snapshots.id })
        .from(snapshots)
        .where(
          and(
            eq(snapshots.id, input.snapshotId),
            eq(snapshots.tenantId, ctx.tenantId),
          ),
        )
        .limit(1);
      if (!snapshotOwner.length) {
        return {
          ok: false,
          error: {
            code: "not_found",
            message: "Snapshot not found in current tenant.",
            retryable: false,
          },
        };
      }

      // Denormalize startsAt/endsAt from the underlying entity
      // (v0.4.12). Earlier versions trusted the agent to pass these
      // fields, but the SKILL.md prompt didn't mention `endsAt`, and
      // the schema marked it optional — so the agent omitted it and
      // every timeline_item landed with endsAt=null. That broke the
      // server-side overlap scan, which filters items without an
      // end time (you can't detect overlap without one). Resolving
      // server-side eliminates the LLM dependency for mechanical
      // data copy. Agent-provided values still win if non-null.
      let resolvedStartsAt: Date | null = input.startsAt
        ? new Date(input.startsAt)
        : null;
      let resolvedEndsAt: Date | null = input.endsAt
        ? new Date(input.endsAt)
        : null;

      if (!resolvedStartsAt || !resolvedEndsAt) {
        if (input.kind === "meeting") {
          const rows = await deps.db
            .select({ startsAt: meetings.startsAt, endsAt: meetings.endsAt })
            .from(meetings)
            .where(
              and(eq(meetings.id, input.refId), eq(meetings.tenantId, ctx.tenantId)),
            )
            .limit(1);
          if (rows[0]) {
            if (!resolvedStartsAt) resolvedStartsAt = rows[0].startsAt;
            if (!resolvedEndsAt) resolvedEndsAt = rows[0].endsAt;
          }
        } else if (input.kind === "ooo") {
          const rows = await deps.db
            .select({ startsAt: oooWindows.startsAt, endsAt: oooWindows.endsAt })
            .from(oooWindows)
            .where(
              and(
                eq(oooWindows.id, input.refId),
                eq(oooWindows.tenantId, ctx.tenantId),
              ),
            )
            .limit(1);
          if (rows[0]) {
            if (!resolvedStartsAt) resolvedStartsAt = rows[0].startsAt;
            if (!resolvedEndsAt) resolvedEndsAt = rows[0].endsAt;
          }
        } else if (input.kind === "trip_leg") {
          // trip_legs has no tenant column — guarded indirectly via
          // the snapshot's tenant ownership, already verified above.
          // endsAt may legitimately be null for a one-way leg; we
          // accept that (won't participate in overlap scan, by design).
          const rows = await deps.db
            .select({ startsAt: tripLegs.startsAt, endsAt: tripLegs.endsAt })
            .from(tripLegs)
            .where(eq(tripLegs.id, input.refId))
            .limit(1);
          if (rows[0]) {
            if (!resolvedStartsAt && rows[0].startsAt)
              resolvedStartsAt = rows[0].startsAt;
            if (!resolvedEndsAt && rows[0].endsAt)
              resolvedEndsAt = rows[0].endsAt;
          }
        }
      }

      if (!resolvedStartsAt) {
        return {
          ok: false,
          error: {
            code: "invalid_input",
            message:
              "Could not resolve startsAt for timeline_item — entity not found or missing time.",
            retryable: false,
          },
        };
      }

      const [row] = await deps.db
        .insert(timelineItems)
        .values({
          snapshotId: input.snapshotId,
          kind: input.kind,
          refId: input.refId,
          startsAt: resolvedStartsAt,
          endsAt: resolvedEndsAt,
          elevated: input.elevated ?? false,
          elevationReason: input.elevationReason ?? null,
          sortOrder: input.sortOrder ?? 0,
        })
        .returning();

      // v0.4.14: the v0.4.11 conflict-scan side-effect was removed.
      // Conflict detection now runs on meetings.upsert_from_calendar
      // and friends, decoupled from snapshots and timeline_items.
      return { ok: true, result: { data: row } };
    },
  };

  // v0.4.54 — batch variant. The day-composer agent uses this so it
  // writes all N timeline items in ONE tool call instead of N
  // (matters because each Claude tool turn is ~$0.05 and ~10s of
  // latency on haiku — batching saves both).
  const createBatch: Tool = {
    name: "timeline_items.create_batch",
    description:
      "Append N timeline items to a snapshot in one call. Use this from the day-composer agent after snapshots.create. Each item: { kind, refId, startsAt, endsAt, elevated?, elevationReason? }. Server denormalizes startsAt/endsAt from the underlying entity when omitted.",
    inputs: z.object({
      snapshotId: z.string().uuid(),
      items: z.array(
        z.object({
          kind: z.enum(["meeting", "trip_leg", "ooo"]),
          refId: z.string().uuid(),
          startsAt: z.string().datetime().optional(),
          endsAt: z.string().datetime().nullable().optional(),
          elevated: z.boolean().optional(),
          elevationReason: z.enum(["imminent", "changed", "agent_flag"]).nullable().optional(),
          sortOrder: z.number().int().optional(),
        }),
      ),
    }),
    async handler(
      input: {
        snapshotId: string;
        items: Array<{
          kind: "meeting" | "trip_leg" | "ooo";
          refId: string;
          startsAt?: string;
          endsAt?: string | null;
          elevated?: boolean;
          elevationReason?: "imminent" | "changed" | "agent_flag" | null;
          sortOrder?: number;
        }>;
      },
      ctx: ToolContext,
    ): Promise<ToolResult> {
      // Tenant guard
      const snapshotOwner = await deps.db
        .select({ id: snapshots.id })
        .from(snapshots)
        .where(
          and(
            eq(snapshots.id, input.snapshotId),
            eq(snapshots.tenantId, ctx.tenantId),
          ),
        )
        .limit(1);
      if (!snapshotOwner.length) {
        return {
          ok: false,
          error: {
            code: "not_found",
            message: "Snapshot not found in current tenant.",
            retryable: false,
          },
        };
      }

      if (input.items.length === 0) {
        return { ok: true, result: { data: { created: 0, items: [] } } };
      }

      // Resolve startsAt/endsAt per item (denormalize from underlying
      // entity when missing). Keeps the agent honest about times.
      const rows: Array<{
        snapshotId: string;
        kind: "meeting" | "trip_leg" | "ooo";
        refId: string;
        startsAt: Date;
        endsAt: Date | null;
        elevated: boolean;
        elevationReason: "imminent" | "changed" | "agent_flag" | null;
        sortOrder: number;
      }> = [];

      for (const item of input.items) {
        let startsAt: Date | null = item.startsAt ? new Date(item.startsAt) : null;
        let endsAt: Date | null = item.endsAt ? new Date(item.endsAt) : null;

        if (!startsAt || !endsAt) {
          if (item.kind === "meeting") {
            const r = await deps.db
              .select({ startsAt: meetings.startsAt, endsAt: meetings.endsAt })
              .from(meetings)
              .where(and(eq(meetings.id, item.refId), eq(meetings.tenantId, ctx.tenantId)))
              .limit(1);
            if (r[0]) {
              startsAt = startsAt ?? r[0].startsAt;
              endsAt = endsAt ?? r[0].endsAt;
            }
          } else if (item.kind === "trip_leg") {
            const r = await deps.db
              .select({ startsAt: tripLegs.startsAt, endsAt: tripLegs.endsAt })
              .from(tripLegs)
              .where(eq(tripLegs.id, item.refId))
              .limit(1);
            if (r[0]) {
              startsAt = startsAt ?? r[0].startsAt;
              endsAt = endsAt ?? r[0].endsAt;
            }
          } else if (item.kind === "ooo") {
            const r = await deps.db
              .select({ startsAt: oooWindows.startsAt, endsAt: oooWindows.endsAt })
              .from(oooWindows)
              .where(and(eq(oooWindows.id, item.refId), eq(oooWindows.tenantId, ctx.tenantId)))
              .limit(1);
            if (r[0]) {
              startsAt = startsAt ?? r[0].startsAt;
              endsAt = endsAt ?? r[0].endsAt;
            }
          }
        }

        if (!startsAt) {
          return {
            ok: false,
            error: {
              code: "invalid_input",
              message: `Could not resolve startsAt for timeline_item kind=${item.kind} refId=${item.refId}.`,
              retryable: false,
            },
          };
        }

        rows.push({
          snapshotId: input.snapshotId,
          kind: item.kind,
          refId: item.refId,
          startsAt,
          endsAt,
          elevated: item.elevated ?? false,
          elevationReason: item.elevationReason ?? null,
          sortOrder: item.sortOrder ?? 0,
        });
      }

      const inserted = await deps.db
        .insert(timelineItems)
        .values(rows)
        .returning();

      return {
        ok: true,
        result: { data: { created: inserted.length, items: inserted } },
      };
    },
  };

  return [list, create, createBatch];
}
