// Server-side timezone localization. Pure functions + the
// resolveTenantTz helper that reads the tenant's memory.
//
// Architectural principle: the LLM does not do timezone math. The
// server takes a UTC ISO string + IANA timezone and returns
// fully-formatted local fields. The agent consumes those verbatim.

import type { ToolContext } from "@boringos/module-sdk";
import { and, eq } from "drizzle-orm";
import { userPreferences } from "../schema/user_preferences.js";
import type { EaDeps } from "../tools/deps.js";

export type DayPart = "morning" | "afternoon" | "evening" | "night";

export type TzResolution = { tz: string } | { error: "tz_not_configured" };

export interface Localized {
  startsAtLocal: string;
  endsAtLocal: string | null;
  startsAtLocalLong: string;
  dayPart: DayPart;
  tzAbbr: string;
  tzIana: string;
}

/**
 * Server-side localization of a meeting/ooo/leg's time pair. Returns
 * the bundle of localized fields that ship alongside the raw ISO
 * timestamps on tool responses, so the agent never has to parse ISO.
 */
export function localizeTimes(
  item: { startsAt: Date; endsAt: Date | null },
  tz: string,
): Localized {
  const startIso = item.startsAt.toISOString();
  const startsAtLocal = formatLocal(startIso, tz);
  const endsAtLocal = item.endsAt
    ? formatLocal(item.endsAt.toISOString(), tz)
    : null;
  const localHour = parseInt(startsAtLocal.slice(0, 2), 10);
  return {
    startsAtLocal,
    endsAtLocal,
    startsAtLocalLong: formatLocalLong(startIso, tz),
    dayPart: dayPartFromHour(localHour),
    tzAbbr: tzAbbr(startIso, tz),
    tzIana: tz,
  };
}

/**
 * Resolve the tenant's active timezone for localization.
 *
 * v0.4.14: reads from the executive_assistant__user_preferences table
 * directly. Previous versions tried to use framework.memory.recall —
 * that was wrong; memory is semantic-search, not key-value, and the
 * calls were silently failing.
 *
 * Order: explicit override → current_location.tz → home_location.tz
 * → { error: "tz_not_configured" }. No silent UTC fallback.
 */
export async function resolveTenantTz(
  ctx: ToolContext,
  deps: EaDeps,
  override?: string,
): Promise<TzResolution> {
  if (override) return { tz: override };

  const keysInOrder = ["current_location", "home_location"];
  for (const key of keysInOrder) {
    try {
      const rows = await deps.db
        .select({ value: userPreferences.value })
        .from(userPreferences)
        .where(
          and(
            eq(userPreferences.tenantId, ctx.tenantId),
            eq(userPreferences.key, key),
          ),
        )
        .limit(1);
      const value = rows[0]?.value;
      if (
        value &&
        typeof value === "object" &&
        "tz" in value &&
        typeof (value as { tz: unknown }).tz === "string" &&
        (value as { tz: string }).tz.length > 0
      ) {
        return { tz: (value as { tz: string }).tz };
      }
    } catch {
      // table missing or other DB hiccup — try the next key
    }
  }
  return { error: "tz_not_configured" };
}

/**
 * Combine resolveTenantTz + localizeTimes for a list of rows. Returns
 * either:
 *   { rows: rowsWithLocalFields, tz }  — when resolution succeeded
 *   { rows: original, tzError }        — when resolution failed
 *
 * Caller spreads into the tool response. Agent learns the tz from
 * either form; never has to do the math itself.
 */
export async function localizeRows<
  T extends { startsAt: Date; endsAt: Date | null },
>(
  rows: T[],
  ctx: ToolContext,
  deps: EaDeps,
  override?: string,
): Promise<
  | { rows: (T & Localized)[]; tz: string }
  | { rows: T[]; tzError: "tz_not_configured" }
> {
  const resolution = await resolveTenantTz(ctx, deps, override);
  if ("error" in resolution) {
    return { rows, tzError: resolution.error };
  }
  const { tz } = resolution;
  return {
    rows: rows.map((r) => ({ ...r, ...localizeTimes(r, tz) })),
    tz,
  };
}

/**
 * Format an ISO UTC timestamp as HH:mm in the given IANA timezone.
 * 24-hour clock, zero-padded. Handles the "24:00" edge case some
 * Node Intl versions emit for midnight by normalising to "00:00".
 */
export function formatLocal(iso: string, tz: string): string {
  const date = new Date(iso);
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const rawHour = parts.find((p) => p.type === "hour")?.value ?? "00";
  const minute = parts.find((p) => p.type === "minute")?.value ?? "00";
  const hour = rawHour === "24" ? "00" : rawHour;
  return `${hour}:${minute}`;
}

/**
 * Long format used in prose: "Sat, May 16 · 15:30 IST".
 * Date components reflect the *local* date in `tz` — so a UTC
 * timestamp that's "yesterday UTC" but "today local" shows the
 * local date.
 */
export function formatLocalLong(iso: string, tz: string): string {
  const date = new Date(iso);
  const dateStr = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(date);
  const timeStr = formatLocal(iso, tz);
  const abbr = tzAbbr(iso, tz);
  return `${dateStr} · ${timeStr} ${abbr}`;
}

/**
 * Pure mapping from local hour (0-23) to a day-part bucket. Removes
 * the "morning/afternoon" inference from the LLM's responsibilities.
 *
 *   5–11   → morning
 *  12–16  → afternoon
 *  17–20  → evening
 *  21–4   → night (wraps midnight)
 */
export function dayPartFromHour(hour: number): DayPart {
  if (hour >= 5 && hour <= 11) return "morning";
  if (hour >= 12 && hour <= 16) return "afternoon";
  if (hour >= 17 && hour <= 20) return "evening";
  return "night";
}

/**
 * Short timezone abbreviation in `tz` at the moment of `iso`. Honours
 * DST: returns "EDT" in summer NYC and "EST" in winter NYC, etc.
 *
 * Two-stage resolution because Node's Intl is inconsistent:
 *   1. Try `timeZoneName: "short"` — works for American zones (EST, EDT, PST…)
 *      but emits ugly "GMT+5:30" for many others (Asia/Kolkata, Europe/London BST…)
 *   2. If short returned a GMT±n / UTC±n form, fall back to `timeZoneName: "long"`
 *      (e.g., "India Standard Time") and extract the initials → "IST".
 */
export function tzAbbr(iso: string, tz: string): string {
  const date = new Date(iso);
  const shortParts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    timeZoneName: "short",
  }).formatToParts(date);
  const shortAbbr =
    shortParts.find((p) => p.type === "timeZoneName")?.value ?? "";
  if (shortAbbr && !/^(GMT|UTC)[+-]/.test(shortAbbr)) {
    return shortAbbr;
  }
  const longParts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    timeZoneName: "long",
  }).formatToParts(date);
  const longName =
    longParts.find((p) => p.type === "timeZoneName")?.value ?? "";
  if (!longName) return shortAbbr || tz;
  if (longName === "Coordinated Universal Time") return "UTC";
  const words = longName.split(/\s+/).filter((w) => /^[A-Z]/.test(w));
  if (words.length === 0) return shortAbbr || tz;
  return words.map((w) => w[0]).join("");
}
