// Calendar sync tool.
//
// One tool, exposed at /api/tools/executive-assistant.calendar.sync_window.
//
// The morning compose and dossier UI read from the `meetings` table.
// Something has to keep that table fresh against Google Calendar.
// This tool does it end-to-end:
//
//   1. Computes a real ISO time window (today through today+N days).
//   2. Gets a valid Google OAuth token via deps.getConnectorToken and
//      calls the Google Calendar REST API directly — typed, not coupled
//      to the tool registry string API.
//   3. Loops the events and dispatches our existing
//      `executive-assistant.meetings.upsert_from_calendar` per event.
//   4. Returns a clean summary: { synced, errors, totalFetched } —
//      OR a fail-soft `{ synced: 0, skipped: true, reason }` shape if
//      Google isn't connected yet, the API rate-limited us, etc.
//
// Replaces the v0.2.x workflow-based sync, which depended on a
// `connector-action` block kind that doesn't exist and a `for-each`
// (hyphen) typo. The routine that fires every 15 minutes now points
// directly at this tool. Simpler, testable, framework-independent.

import { z } from "@boringos/module-sdk";
import type { Tool, ToolContext, ToolResult } from "@boringos/module-sdk";
import { invoke } from "@boringos/agent";
import { and, eq, sql } from "drizzle-orm";
import { userPreferences } from "../schema/user_preferences.js";
import type { EaDeps } from "./deps.js";

type SkipReason =
  | "tool_registry_unavailable"
  | "google_not_connected"
  | "google_upstream_unavailable"
  | "google_returned_error"
  | "sync_token_expired";

const SYNC_TOKEN_KEY = "google_calendar_sync_token";

const CALENDAR_API = "https://www.googleapis.com/calendar/v3/calendars/primary/events";

interface GoogleCalendarEvent {
  id: string;
  status?: string;  // "confirmed" | "tentative" | "cancelled" (incremental sync)
  summary?: string;
  description?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  location?: string | null;
  conferenceData?: {
    entryPoints?: Array<{ uri?: string | null }>;
  };
  organizer?: { email?: string | null };
  attendees?: Array<{ email?: string | null; displayName?: string | null }>;
}


function classifyError(err: unknown): SkipReason {
  const msg = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase();
  if (msg.includes("not connected") || msg.includes("no credentials") || msg.includes("unauthorized")) {
    return "google_not_connected";
  }
  if (msg.includes("rate") || msg.includes("quota") || msg.includes("503") || msg.includes("502")) {
    return "google_upstream_unavailable";
  }
  return "google_returned_error";
}

/**
 * Normalize a Google Calendar start/end timestamp to a Z-terminated
 * ISO 8601 string the meetings.upsert_from_calendar Zod schema will
 * accept. Handles three input shapes:
 *
 *   - Timed event in UTC:        "2026-05-15T04:00:00Z"     → kept
 *   - Timed event with offset:   "2026-05-15T09:30:00+05:30" → Z-form
 *   - All-day event (date only): "2026-05-15"               → midnight UTC
 *
 * Returns null if input is missing or unparseable; the caller skips
 * the event in that case.
 */
function normalizeIsoZ(input: string | undefined): string | null {
  if (!input) return null;
  const d = new Date(input);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

export function createCalendarTools(deps: EaDeps): Tool[] {
  const syncWindow: Tool = {
    name: "calendar.sync_window",
    description:
      "Fetch upcoming Google Calendar events for the current tenant and upsert them into the meetings table. Defaults to today through today+7 days. Fail-soft when Google isn't connected — returns ok:true with a `skipped` reason rather than throwing.",
    inputs: z.object({
      days: z.number().int().positive().max(30).optional(),
    }),
    async handler(
      input: { days?: number },
      ctx: ToolContext,
    ): Promise<ToolResult> {
      if (!deps.toolRegistry) {
        return {
          ok: true,
          result: {
            data: { synced: 0, skipped: true, reason: "tool_registry_unavailable" satisfies SkipReason },
          },
        };
      }

      // Window math — only used when we need a FULL sync (no stored
      // syncToken). Once a sync token exists, Google rejects timeMin/
      // timeMax and we get all changed events regardless of date.
      const now = new Date();
      const days = input.days ?? 7;
      const dayOfWeek = now.getUTCDay();
      const daysFromMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
      const weekStart = new Date(Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth(),
        now.getUTCDate() - daysFromMonday,
        0, 0, 0, 0,
      ));
      const end = new Date(weekStart.getTime() + days * 86_400_000);
      const timeMin = weekStart.toISOString();
      const timeMax = end.toISOString();

      // v0.4.33: pass our module id so audit rows in
      // `connector_token_issuance` attribute correctly. Frameworks
      // that predate the audit hook ignore the third arg.
      const tokenResult = await deps.getConnectorToken?.("google", ctx.tenantId, "executive-assistant") ?? null;
      if (!tokenResult) {
        console.warn(`[ea.calendar.sync_window] skipped — google_not_connected for tenant ${ctx.tenantId}`);
        return {
          ok: true,
          result: { data: { synced: 0, skipped: true, reason: "google_not_connected" satisfies SkipReason } },
        };
      }

      // v0.4.19 — read stored Google syncToken. If present, this is an
      // incremental sync (returns only changed/cancelled events since
      // last successful sync). If absent, full sync.
      const storedRow = await deps.db
        .select({ value: userPreferences.value })
        .from(userPreferences)
        .where(
          and(
            eq(userPreferences.tenantId, ctx.tenantId),
            eq(userPreferences.key, SYNC_TOKEN_KEY),
          ),
        )
        .limit(1);
      const storedToken =
        (storedRow[0]?.value as { token?: string } | undefined)?.token ?? null;

      // Build the right query depending on sync mode.
      // Google rejects mixing syncToken with timeMin/timeMax/singleEvents/orderBy
      // — must be one or the other.
      const params = storedToken
        ? new URLSearchParams({ syncToken: storedToken, maxResults: "250" })
        : new URLSearchParams({
            timeMin,
            timeMax,
            maxResults: "250",
            singleEvents: "true",
            orderBy: "startTime",
          });
      const syncMode: "incremental" | "full" = storedToken ? "incremental" : "full";

      let rawEvents: GoogleCalendarEvent[];
      let nextSyncToken: string | null = null;
      try {
        const res = await fetch(`${CALENDAR_API}?${params}`, {
          headers: { Authorization: `Bearer ${tokenResult.accessToken}` },
        });

        // 410 Gone = sync token expired/invalid. Clear it and bail —
        // the next cron tick will do a fresh full sync.
        if (res.status === 410) {
          console.warn(`[ea.calendar.sync_window] sync token expired for tenant ${ctx.tenantId}; clearing`);
          await deps.db.execute(sql`
            DELETE FROM executive_assistant__user_preferences
             WHERE tenant_id = ${ctx.tenantId}
               AND key = ${SYNC_TOKEN_KEY}
          `);
          return {
            ok: true,
            result: {
              data: {
                synced: 0,
                skipped: true,
                reason: "sync_token_expired" satisfies SkipReason,
              },
            },
          };
        }

        if (!res.ok) {
          const reason = classifyError(new Error(`${res.status}`));
          console.warn(`[ea.calendar.sync_window] skipped — ${reason} (HTTP ${res.status})`);
          return {
            ok: true,
            result: { data: { synced: 0, skipped: true, reason, error: `HTTP ${res.status}` } },
          };
        }

        const body = (await res.json()) as {
          items?: GoogleCalendarEvent[];
          nextSyncToken?: string;
        };
        rawEvents = body.items ?? [];
        nextSyncToken = body.nextSyncToken ?? null;
      } catch (err) {
        const reason = classifyError(err);
        console.warn(`[ea.calendar.sync_window] skipped — ${reason}:`, err instanceof Error ? err.message : err);
        return {
          ok: true,
          result: { data: { synced: 0, skipped: true, reason, error: String(err) } },
        };
      }

      const events = rawEvents;

      // Upsert each event. v0.4.19: cancelled events come back on
      // incremental sync with status='cancelled' — skip them (don't
      // upsert as a real meeting). Deleting the row to match deletion
      // is a TODO; for now the row stays but won't be re-confirmed.
      let synced = 0;
      let cancelled = 0;
      let errors = 0;
      for (const ev of events) {
        if (ev.status === "cancelled") {
          cancelled++;
          continue;
        }
        const startsAt = normalizeIsoZ(ev.start?.dateTime ?? ev.start?.date);
        const endsAt = normalizeIsoZ(ev.end?.dateTime ?? ev.end?.date);
        if (!ev.id || !startsAt || !endsAt) {
          errors++;
          continue;
        }
        try {
          const upsertResult = await invoke(
            { registry: deps.toolRegistry, db: deps.db as unknown as never },
            "executive-assistant.meetings.upsert_from_calendar",
            {
              googleEventId: ev.id,
              title: ev.summary ?? "(no title)",
              startsAt,
              endsAt,
              location: ev.location ?? null,
              conferenceLink: ev.conferenceData?.entryPoints?.[0]?.uri ?? null,
              organizerEmail: ev.organizer?.email ?? null,
              description: ev.description ?? null,
              attendees: ev.attendees ?? [],
            },
            { ...ctx, invokedBy: "internal" },
          );
          if (upsertResult.ok) {
            synced++;
          } else {
            errors++;
            console.warn(
              `[ea.calendar.sync_window] upsert failed for ${ev.id}: ${upsertResult.error.message}`,
            );
          }
        } catch (err) {
          errors++;
          console.warn(
            `[ea.calendar.sync_window] upsert threw for ${ev.id}:`,
            err instanceof Error ? err.message : err,
          );
        }
      }

      // v0.4.19 — persist the new syncToken so the next call is
      // incremental. nextSyncToken is only present on the final page;
      // we don't paginate yet (TODO if a tenant ever has >250 events
      // changed in a single tick, vanishingly rare for a personal
      // calendar at 1-min cadence).
      if (nextSyncToken) {
        await deps.db.execute(sql`
          INSERT INTO executive_assistant__user_preferences
            (tenant_id, key, value, updated_at)
          VALUES
            (${ctx.tenantId}, ${SYNC_TOKEN_KEY}, ${JSON.stringify({ token: nextSyncToken })}::jsonb, now())
          ON CONFLICT (tenant_id, key) DO UPDATE
            SET value = EXCLUDED.value, updated_at = now()
        `);
      }

      console.log(
        `[ea.calendar.sync_window] ${syncMode} sync: ${synced} synced, ${cancelled} cancelled, ${errors} errors (tenant ${ctx.tenantId})`,
      );
      return {
        ok: true,
        result: {
          data: {
            syncMode,
            synced,
            cancelled,
            errors,
            totalFetched: events.length,
            ...(syncMode === "full" ? { window: { timeMin, timeMax, days } } : {}),
          },
        },
      };
    },
  };

  return [syncWindow];
}
