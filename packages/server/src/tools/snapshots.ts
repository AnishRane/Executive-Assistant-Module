// Snapshot tools — read (list, get) + write (create).
// Dispatched at /api/tools/executive-assistant.snapshots.<name>.
//
// snapshots.create is the agent's primary write during morning compose.
// It supersedes any existing composed snapshot for the same date in a
// single round-trip — the partial unique index from migration 002
// guarantees one composed row per (tenant, date) without blocking
// supersession history.

import { z } from "@boringos/module-sdk";
import type { Tool, ToolContext, ToolResult } from "@boringos/module-sdk";
import { eq, and, desc } from "drizzle-orm";
import { snapshots } from "../schema/snapshots.js";
import { computeStateHash } from "../services/compose_hash.js";
import type { EaDeps } from "./deps.js";

export function createSnapshotTools(deps: EaDeps): Tool[] {
  const create: Tool = {
    name: "snapshots.create",
    description:
      "Compose a snapshot for the given date. Call with { snapshotDate: 'YYYY-MM-DD', narrativeBrief: '<the day brief prose>' }. If a composed snapshot already exists for that date, it is marked superseded first. Returns the newly created row.",
    inputs: z.object({
      snapshotDate: z.string().date(),
      narrativeBrief: z.string().min(1),
    }),
    async handler(
      input: { snapshotDate: string; narrativeBrief: string },
      ctx: ToolContext,
    ): Promise<ToolResult> {
      await deps.db
        .update(snapshots)
        .set({ status: "superseded" })
        .where(
          and(
            eq(snapshots.tenantId, ctx.tenantId),
            eq(snapshots.snapshotDate, input.snapshotDate),
            eq(snapshots.status, "composed"),
          ),
        );

      // Phase E — compute the input-state hash so the next routine
      // tick can compare and skip the LLM wake when state is stable.
      // Best-effort: if hashing fails, we still create the snapshot
      // with a null hash (the gate falls back to "always recompose"
      // which is the desired migration behavior).
      let stateHash: string | null = null;
      try {
        stateHash = await computeStateHash(
          deps.db,
          ctx.tenantId,
          input.snapshotDate,
        );
      } catch (err) {
        console.warn(
          `[ea.snapshots.create] state hash computation failed for ${ctx.tenantId}/${input.snapshotDate}:`,
          err instanceof Error ? err.message : err,
        );
      }

      const [created] = await deps.db
        .insert(snapshots)
        .values({
          tenantId: ctx.tenantId,
          snapshotDate: input.snapshotDate,
          narrativeBrief: input.narrativeBrief,
          status: "composed",
          stateHash,
        })
        .returning();

      return { ok: true, result: { data: created } };
    },
  };

  const list: Tool = {
    name: "snapshots.list",
    description:
      "List snapshots for the current tenant, most recent first. By default returns only composed snapshots.",
    inputs: z.object({
      includeSuperseded: z.boolean().optional(),
      limit: z.number().int().positive().max(500).optional(),
      offset: z.number().int().nonnegative().optional(),
    }),
    async handler(
      input: { includeSuperseded?: boolean; limit?: number; offset?: number },
      ctx: ToolContext,
    ): Promise<ToolResult> {
      const conds = [eq(snapshots.tenantId, ctx.tenantId)];
      if (!input.includeSuperseded) {
        conds.push(eq(snapshots.status, "composed"));
      }
      const limit = input.limit ?? 90;
      const offset = input.offset ?? 0;
      const rows = await deps.db
        .select()
        .from(snapshots)
        .where(and(...conds))
        .orderBy(desc(snapshots.snapshotDate))
        .limit(limit)
        .offset(offset);
      return {
        ok: true,
        result: { data: rows, total: rows.length, limit, offset },
      };
    },
  };

  const get: Tool = {
    name: "snapshots.get",
    description: "Fetch one snapshot by id.",
    inputs: z.object({ id: z.string().uuid() }),
    async handler(
      input: { id: string },
      ctx: ToolContext,
    ): Promise<ToolResult> {
      const row = await deps.db
        .select()
        .from(snapshots)
        .where(and(eq(snapshots.id, input.id), eq(snapshots.tenantId, ctx.tenantId)))
        .limit(1);
      if (!row.length) {
        return {
          ok: false,
          error: { code: "not_found", message: "Snapshot not found", retryable: false },
        };
      }
      return { ok: true, result: { data: row[0] } };
    },
  };

  return [create, list, get];
}
