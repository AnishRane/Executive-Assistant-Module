// Preferences tools — structured per-tenant key/value settings.
// Lives in the EA module's own schema (executive_assistant__user_preferences)
// because the framework's memory tool is semantic-search, not key-value.
//
// Keys in active use as of v0.4.14:
//   home_location     → { label, latitude?, longitude?, tz }
//   current_location  → { label, latitude?, longitude?, tz }

import { z } from "@boringos/module-sdk";
import type { Tool, ToolContext, ToolResult } from "@boringos/module-sdk";
import { and, eq, sql } from "drizzle-orm";
import { userPreferences } from "../schema/user_preferences.js";
import type { EaDeps } from "./deps.js";

export function createPreferencesTools(deps: EaDeps): Tool[] {
  const set: Tool = {
    name: "preferences.set",
    description:
      "Upsert a structured tenant preference. Stores the full JSONB value at (tenant, key). Used by the UI for location bootstrap (home_location, current_location).",
    inputs: z.object({
      key: z.string().min(1),
      value: z.record(z.string(), z.unknown()),
    }),
    async handler(
      input: { key: string; value: Record<string, unknown> },
      ctx: ToolContext,
    ): Promise<ToolResult> {
      await deps.db.execute(sql`
        INSERT INTO executive_assistant__user_preferences (tenant_id, key, value, updated_at)
        VALUES (${ctx.tenantId}, ${input.key}, ${JSON.stringify(input.value)}::jsonb, now())
        ON CONFLICT (tenant_id, key) DO UPDATE
          SET value = EXCLUDED.value, updated_at = now()
      `);
      return { ok: true, result: { data: { key: input.key } } };
    },
  };

  const get: Tool = {
    name: "preferences.get",
    description:
      "Fetch a structured preference value by key. Returns { value: null } when the key has never been set.",
    inputs: z.object({ key: z.string().min(1) }),
    async handler(
      input: { key: string },
      ctx: ToolContext,
    ): Promise<ToolResult> {
      const rows = await deps.db
        .select({ value: userPreferences.value })
        .from(userPreferences)
        .where(
          and(
            eq(userPreferences.tenantId, ctx.tenantId),
            eq(userPreferences.key, input.key),
          ),
        )
        .limit(1);
      return {
        ok: true,
        result: { data: { value: rows[0]?.value ?? null } },
      };
    },
  };

  return [set, get];
}
