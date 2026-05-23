// Day-signal derivation. Pre-computes the shape the LLM should
// reference verbatim when composing the day's narrative brief.
//
// Architectural principle: server does the math, LLM does the prose.
// Bucketing meetings into morning/afternoon/evening/night is
// mechanical and should never live in the agent's inference path.

import { and, eq, gte, lt } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { meetings } from "../schema/meetings.js";
import { oooWindows } from "../schema/ooo_windows.js";
import { userPreferences } from "../schema/user_preferences.js";
import { dayPartFromHour, formatLocal } from "./tz.js";
import { resolveTenantTz } from "./tz.js";
import type { EaDeps } from "../tools/deps.js";
import type { ToolContext } from "@boringos/module-sdk";

export type DayShape =
  | "quiet"
  | "morning-heavy"
  | "afternoon-heavy"
  | "evening-heavy"
  | "after-hours"
  | "balanced"
  | "back-to-back";

/**
 * Categorize a day by the LOCAL start hours of its meetings.
 *
 * Pure function: hours array in, label out. No tz math, no I/O.
 * Caller is responsible for converting timestamps to local hours
 * first (use formatLocal then parse the leading 2 chars).
 *
 * Rule precedence: back-to-back wins over single-bucket labels
 * because cluster density is the more useful narrative cue.
 */
export function categorizeDayShape(localHours: number[]): DayShape {
  if (localHours.length === 0) return "quiet";

  // Back-to-back wins first. A 5-hour rolling window with 4+ starts
  // is the threshold; tune later if it feels off.
  const sorted = [...localHours].sort((a, b) => a - b);
  for (let i = 0; i < sorted.length; i++) {
    let count = 1;
    for (let j = i + 1; j < sorted.length; j++) {
      if (sorted[j]! - sorted[i]! <= 5) count++;
    }
    if (count >= 4) return "back-to-back";
  }

  // Single-bucket labels (every meeting falls in one part of the day).
  const parts = new Set(localHours.map((h) => dayPartFromHour(h)));
  if (parts.size === 1) {
    const [only] = parts;
    if (only === "morning") return "morning-heavy";
    if (only === "afternoon") return "afternoon-heavy";
    if (only === "evening") return "evening-heavy";
    if (only === "night") return "after-hours";
  }

  return "balanced";
}

export interface TravelState {
  isAway: boolean;
  currentLabel: string;
  currentTz: string;
  homeLabel: string;
  homeTz: string;
}

export interface DaySignal {
  forDate: string;
  meetingCount: number;
  oooCount: number;
  dayShape: DayShape;
  /** Server-localized first-meeting time, useful for "starts at X" prose. */
  firstMeetingLocal: string | null;
  /** Server-localized last-meeting end time, useful for "wraps by X" prose. */
  lastMeetingEndLocal: string | null;
  /** null when home_location is unset or matches current — agent can skip mentioning travel. */
  travel: TravelState | null;
}

/**
 * Compute the day signal server-side. Reads meetings + ooo for the
 * date window, resolves tz from preferences, derives the shape +
 * travel state, returns one structured payload the agent can
 * reference without further inference.
 */
export async function computeDaySignal(
  db: PostgresJsDatabase,
  ctx: ToolContext,
  deps: EaDeps,
  forDate: string,
): Promise<DaySignal> {
  const dayStart = new Date(`${forDate}T00:00:00.000Z`);
  const dayEnd = new Date(dayStart.getTime() + 86_400_000);

  // Pull the day's meetings + ooo. trip_legs are excluded from the
  // shape calc; they affect the day differently (travel days have
  // their own structural meaning we handle via travel state).
  const meetingRows = await db
    .select({ startsAt: meetings.startsAt, endsAt: meetings.endsAt })
    .from(meetings)
    .where(
      and(
        eq(meetings.tenantId, ctx.tenantId),
        gte(meetings.startsAt, dayStart),
        lt(meetings.startsAt, dayEnd),
      ),
    );

  const oooRows = await db
    .select({ id: oooWindows.id })
    .from(oooWindows)
    .where(
      and(
        eq(oooWindows.tenantId, ctx.tenantId),
        gte(oooWindows.startsAt, dayStart),
        lt(oooWindows.startsAt, dayEnd),
      ),
    );

  // Resolve tz so we can compute local hours; fall back to UTC if
  // unset so the function never throws.
  const tzResult = await resolveTenantTz(ctx, deps);
  const tz = "tz" in tzResult ? tzResult.tz : "UTC";

  const localHours: number[] = [];
  let earliestStartMs = Infinity;
  let latestEndMs = -Infinity;
  for (const m of meetingRows) {
    const local = formatLocal(m.startsAt.toISOString(), tz);
    const h = parseInt(local.slice(0, 2), 10);
    if (!Number.isNaN(h)) localHours.push(h);
    if (m.startsAt.getTime() < earliestStartMs) earliestStartMs = m.startsAt.getTime();
    if (m.endsAt.getTime() > latestEndMs) latestEndMs = m.endsAt.getTime();
  }

  const dayShape = categorizeDayShape(localHours);

  const firstMeetingLocal =
    earliestStartMs !== Infinity
      ? formatLocal(new Date(earliestStartMs).toISOString(), tz)
      : null;
  const lastMeetingEndLocal =
    latestEndMs !== -Infinity
      ? formatLocal(new Date(latestEndMs).toISOString(), tz)
      : null;

  // Travel state from preferences. Both keys must be set and the tz
  // must differ for isAway to be true.
  const prefRows = await db
    .select({ key: userPreferences.key, value: userPreferences.value })
    .from(userPreferences)
    .where(eq(userPreferences.tenantId, ctx.tenantId));
  const prefs = new Map(prefRows.map((r) => [r.key, r.value]));
  const current = prefs.get("current_location") as
    | { label?: string; tz?: string }
    | undefined;
  const home = prefs.get("home_location") as
    | { label?: string; tz?: string }
    | undefined;

  let travel: TravelState | null = null;
  if (current?.tz && home?.tz && current?.label && home?.label) {
    travel = {
      isAway: current.tz !== home.tz,
      currentLabel: current.label,
      currentTz: current.tz,
      homeLabel: home.label,
      homeTz: home.tz,
    };
  }

  return {
    forDate,
    meetingCount: meetingRows.length,
    oooCount: oooRows.length,
    dayShape,
    firstMeetingLocal,
    lastMeetingEndLocal,
    travel,
  };
}
