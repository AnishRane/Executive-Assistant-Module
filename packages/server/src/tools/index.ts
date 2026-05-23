// Aggregates every EA tool factory. Each entity-specific file
// exports a create<Group>Tools(deps): Tool[] function; this module
// flattens them into a single array passed to Module.tools in
// module.ts.
//
// Tool dispatch URL pattern:
//   /api/tools/executive-assistant.<group>.<verb>
// e.g. executive-assistant.meetings.list,
//      executive-assistant.snapshots.create,
//      executive-assistant.thread_excerpts.create
//
// v0.4.34 — when env `EA_TRACE=1`, every tool handler is wrapped with
// a thin timing logger so a single brief-generation run can be traced
// step-by-step in the server's stderr. No-op when the flag is unset.

import type { Tool, ToolContext, ToolResult } from "@boringos/module-sdk";
import { createMeetingTools } from "./meetings.js";
import { createTripTools } from "./trips.js";
import { createOooTools } from "./ooo.js";
import { createEmailAnchorTools } from "./email_anchors.js";
import { createTripLegTools } from "./trip_legs.js";
import { createSnapshotTools } from "./snapshots.js";
import { createTimelineItemTools } from "./timeline_items.js";
import { createThreadExcerptTools } from "./thread_excerpts.js";
import { createActionItemTools } from "./action_items.js";
import { createDeltaTools } from "./deltas.js";
import { createConflictTools } from "./conflicts.js";
import { createFeedbackSignalTools } from "./feedback_signals.js";
import { createWeatherTools } from "./weather.js";
import { createCalendarTools } from "./calendar.js";
import { createComposeTools } from "./compose.js";
import { createPreferencesTools } from "./preferences.js";
import type { EaDeps } from "./deps.js";
import { trace, TRACE_ENABLED } from "../services/trace.js";

const TRACE = TRACE_ENABLED;

// Truncate values so each trace line stays scannable.
const TRACE_VAL_MAX = 120;

function summarize(v: unknown): string {
  if (v == null) return String(v);
  if (typeof v === "string")
    return v.length > TRACE_VAL_MAX ? `"${v.slice(0, TRACE_VAL_MAX)}…"` : `"${v}"`;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v))
    return `[${v.length} item${v.length === 1 ? "" : "s"}]`;
  if (typeof v === "object") {
    const keys = Object.keys(v as object);
    if (keys.length <= 3) {
      const pairs = keys
        .map(
          (k) => `${k}: ${summarize((v as Record<string, unknown>)[k])}`,
        )
        .join(", ");
      const s = `{${pairs}}`;
      return s.length > TRACE_VAL_MAX ? `{…${keys.length} keys}` : s;
    }
    return `{…${keys.length} keys}`;
  }
  return "<?>";
}

function wrap(t: Tool): Tool {
  if (!TRACE) return t;
  const original = t.handler;
  const tracedTool: Tool = {
    ...t,
    async handler(inputs, ctx: ToolContext): Promise<ToolResult> {
      const start = Date.now();
      const name = `executive-assistant.${t.name}`;
      trace(`[ea.trace] → ${name} in=${summarize(inputs)}`);
      try {
        const result = (await (original as (
          i: unknown,
          c: ToolContext,
        ) => Promise<ToolResult>)(inputs, ctx)) as ToolResult;
        const ms = Date.now() - start;
        const status = result.ok ? "ok" : `err:${result.error.code}`;
        trace(`[ea.trace] ← ${name} ${ms}ms ${status}`);
        return result;
      } catch (err) {
        const ms = Date.now() - start;
        trace(
          `[ea.trace] ← ${name} ${ms}ms THREW: ${err instanceof Error ? err.message : String(err)}`,
        );
        throw err;
      }
    },
  };
  return tracedTool;
}

export function createExecutiveAssistantTools(deps: EaDeps): Tool[] {
  const all: Tool[] = [
    ...createMeetingTools(deps),
    ...createTripTools(deps),
    ...createOooTools(deps),
    ...createEmailAnchorTools(deps),
    ...createTripLegTools(deps),
    ...createSnapshotTools(deps),
    ...createTimelineItemTools(deps),
    ...createThreadExcerptTools(deps),
    ...createActionItemTools(deps),
    ...createDeltaTools(deps),
    ...createConflictTools(deps),
    ...createFeedbackSignalTools(deps),
    ...createWeatherTools(deps),
    ...createCalendarTools(deps),
    ...createComposeTools(deps),
    ...createPreferencesTools(deps),
  ];
  if (TRACE) {
    // One-shot startup confirmation. If you don't see this in stderr
    // or the trace file, EA_TRACE wasn't set when the host booted.
    trace(
      `[ea.trace] EA_TRACE enabled — wrapping ${all.length} tools — file=${process.env.EA_TRACE_FILE ?? "./ea-trace.log"}`,
    );
  }
  return all.map(wrap);
}
