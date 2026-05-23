// Weather tools — fetch (agent-driven), get (UI read), dismiss (feedback).
// Dispatched at /api/tools/executive-assistant.weather.<verb>.
//
// v0.1 wiring:
//   - The morning-compose agent resolves location (trip destination or
//     david.home_location from memory) and calls weather.fetch_for_date
//     once per day. The tool calls Open-Meteo and upserts a row.
//   - The Today view calls weather.get_for_snapshot to render a small
//     block above the narrative. If no row, the block is hidden.
//   - David can dismiss / mark too detailed / too terse via the block's
//     overflow menu; each writes a feedback_signal for the daily/weekly
//     reflection to act on.

import { z } from "@boringos/module-sdk";
import type { Tool, ToolContext, ToolResult } from "@boringos/module-sdk";
import { and, eq, desc } from "drizzle-orm";
import { weatherSnapshots } from "../schema/weather_snapshots.js";
import { fetchOpenMeteoDaily, defaultSummary } from "../services/weather.js";
import { writeFeedback } from "../services/feedback.js";
import type { EaDeps } from "./deps.js";

export function createWeatherTools(deps: EaDeps): Tool[] {
  const fetchForDate: Tool = {
    name: "weather.fetch_for_date",
    description:
      "Fetch the daily forecast for (forDate, latitude, longitude) from Open-Meteo and upsert it for the current tenant. locationLabel is the display string ('Mumbai, IN') the UI shows. If summary is provided, it's used verbatim — otherwise a default condition · range one-liner is stored.",
    inputs: z.object({
      forDate: z.string().date(),
      locationLabel: z.string().min(1),
      latitude: z.number().min(-90).max(90),
      longitude: z.number().min(-180).max(180),
      tz: z.string().min(1),
      summary: z.string().optional(),
    }),
    async handler(
      input: {
        forDate: string;
        locationLabel: string;
        latitude: number;
        longitude: number;
        tz: string;
        summary?: string;
      },
      ctx: ToolContext,
    ): Promise<ToolResult> {
      let daily;
      try {
        daily = await fetchOpenMeteoDaily({
          latitude: input.latitude,
          longitude: input.longitude,
          forDate: input.forDate,
          tz: input.tz,
        });
      } catch (err) {
        return {
          ok: false,
          error: {
            code: "upstream_unavailable",
            message: err instanceof Error ? err.message : "open-meteo failed",
            retryable: true,
          },
        };
      }

      const summary = input.summary ?? defaultSummary(daily);

      // Upsert via the partial unique index on
      // (tenant_id, for_date, location_label).
      const existing = await deps.db
        .select({ id: weatherSnapshots.id })
        .from(weatherSnapshots)
        .where(
          and(
            eq(weatherSnapshots.tenantId, ctx.tenantId),
            eq(weatherSnapshots.forDate, input.forDate),
            eq(weatherSnapshots.locationLabel, input.locationLabel),
          ),
        )
        .limit(1);

      const finiteOrNull = (n: number) => (Number.isFinite(n) ? n : null);
      const values = {
        tenantId: ctx.tenantId,
        forDate: input.forDate,
        locationLabel: input.locationLabel,
        latitude: input.latitude,
        longitude: input.longitude,
        tz: input.tz,

        summary,
        conditionCode: daily.conditionCode,
        conditionLabel: daily.conditionLabel,

        tempHighC: finiteOrNull(daily.tempHighC),
        tempLowC: finiteOrNull(daily.tempLowC),
        tempApparentHighC: finiteOrNull(daily.tempApparentHighC),
        tempApparentLowC: finiteOrNull(daily.tempApparentLowC),

        precipProbabilityMax: daily.precipProbabilityMax,
        precipitationMm: daily.precipitationMm,

        windSpeedMaxKmh: daily.windSpeedMaxKmh,
        windGustsMaxKmh: daily.windGustsMaxKmh,

        uvIndexMax: daily.uvIndexMax,

        sunrise: daily.sunrise ? new Date(daily.sunrise) : null,
        sunset: daily.sunset ? new Date(daily.sunset) : null,

        rawPayload: daily.raw,
        fetchedAt: new Date(),
      };

      let row;
      if (existing.length) {
        [row] = await deps.db
          .update(weatherSnapshots)
          .set(values)
          .where(eq(weatherSnapshots.id, existing[0]!.id))
          .returning();
      } else {
        [row] = await deps.db.insert(weatherSnapshots).values(values).returning();
      }
      return { ok: true, result: { data: row } };
    },
  };

  const getForSnapshot: Tool = {
    name: "weather.get_for_snapshot",
    description:
      "Return the most recent weather snapshot for (tenant, forDate). Optionally filter by locationLabel. Returns null if none.",
    inputs: z.object({
      forDate: z.string().date(),
      locationLabel: z.string().optional(),
    }),
    async handler(
      input: { forDate: string; locationLabel?: string },
      ctx: ToolContext,
    ): Promise<ToolResult> {
      const conds = [
        eq(weatherSnapshots.tenantId, ctx.tenantId),
        eq(weatherSnapshots.forDate, input.forDate),
      ];
      if (input.locationLabel) {
        conds.push(eq(weatherSnapshots.locationLabel, input.locationLabel));
      }
      const rows = await deps.db
        .select()
        .from(weatherSnapshots)
        .where(and(...conds))
        .orderBy(desc(weatherSnapshots.fetchedAt))
        .limit(1);
      return { ok: true, result: { data: rows[0] ?? null } };
    },
  };

  const dismiss: Tool = {
    name: "weather.dismiss",
    description:
      "Record David's feedback on the weather block: dismissed it for the day, found it too detailed, or too terse. Writes a feedback signal (weather_dismissed / weather_too_detailed / weather_too_terse) the daily/weekly reflection uses to tune.",
    inputs: z.object({
      id: z.string().uuid(),
      kind: z.enum(["dismissed", "too_detailed", "too_terse"]),
    }),
    async handler(
      input: { id: string; kind: "dismissed" | "too_detailed" | "too_terse" },
      ctx: ToolContext,
    ): Promise<ToolResult> {
      const owner = await deps.db
        .select()
        .from(weatherSnapshots)
        .where(
          and(
            eq(weatherSnapshots.id, input.id),
            eq(weatherSnapshots.tenantId, ctx.tenantId),
          ),
        )
        .limit(1);
      if (!owner.length) {
        return {
          ok: false,
          error: { code: "not_found", message: "Weather snapshot not found", retryable: false },
        };
      }
      const signalKind =
        input.kind === "dismissed"
          ? "weather_dismissed"
          : input.kind === "too_detailed"
            ? "weather_too_detailed"
            : "weather_too_terse";

      await writeFeedback(deps.db, {
        tenantId: ctx.tenantId,
        signalKind,
        subjectKind: "weather",
        subjectId: input.id,
        value: {
          locationLabel: owner[0]!.locationLabel,
          forDate: owner[0]!.forDate,
          conditionCode: owner[0]!.conditionCode,
          summary: owner[0]!.summary,
        },
        createdByUserId: ctx.wakeOwnerUserId ?? null,
      });

      return { ok: true, result: { data: { recorded: true, signalKind } } };
    },
  };

  return [fetchForDate, getForSnapshot, dismiss];
}
