// trip_legs.reconcile_from_email — pure persistence path.
//
// Architecture note (post-refactor): EA no longer does its own regex
// parsing. The ea-travel-agent reads inbox items that triage has
// classified, uses its LLM to decide if an email is travel-related,
// extracts structured fields, and calls this tool. The tool accepts
// the already-extracted fields and persists them to trip_legs with
// PNR-based dedup against the (trip_id, kind, confirmation_code)
// partial unique index.
//
// Dispatched at:
//   /api/tools/executive-assistant.trip_legs.reconcile_from_email
//
// Called by:
//   - ea-travel-agent on triage.classified events (primary path)
//   - the executive-assistant agent during morning compose if it
//     sees an email it should reconcile but the travel agent hasn't yet

import { z } from "@boringos/module-sdk";
import type { Tool, ToolContext, ToolResult } from "@boringos/module-sdk";
import { findOrCreateTrip, reconcileLeg } from "../services/reconciler.js";
import type { ParsedLeg } from "../types.js";
import type { EaDeps } from "./deps.js";

export function createTripLegTools(deps: EaDeps): Tool[] {
  const reconcileFromEmail: Tool = {
    name: "trip_legs.reconcile_from_email",
    description:
      "Persist an already-extracted trip leg from an email. The agent does the extraction (kind, confirmation code, dates, route). This tool finds-or-creates the parent trip, then upserts the leg with PNR dedup. Idempotent — same (trip_id, kind, confirmation_code) → same row, with the new email id appended to source_message_ids.",
    inputs: z.object({
      gmailMessageId: z.string(),
      kind: z.enum(["flight", "hotel", "ground"]),
      provider: z.string().min(1),
      confirmationCode: z.string().nullable().optional(),
      startsAt: z.string().datetime().nullable().optional(),
      endsAt: z.string().datetime().nullable().optional(),
      originLocation: z.string().nullable().optional(),
      destinationLocation: z.string().nullable().optional(),
      currentState: z.record(z.unknown()).optional(),
      tripHint: z.object({
        destination: z.string().nullable().optional(),
        startsOn: z.string().date().nullable().optional(),
        endsOn: z.string().date().nullable().optional(),
      }),
    }),
    async handler(
      input: {
        gmailMessageId: string;
        kind: "flight" | "hotel" | "ground";
        provider: string;
        confirmationCode?: string | null;
        startsAt?: string | null;
        endsAt?: string | null;
        originLocation?: string | null;
        destinationLocation?: string | null;
        currentState?: Record<string, unknown>;
        tripHint: {
          destination?: string | null;
          startsOn?: string | null;
          endsOn?: string | null;
        };
      },
      ctx: ToolContext,
    ): Promise<ToolResult> {
      const parsed: ParsedLeg = {
        kind: input.kind,
        provider: input.provider,
        confirmationCode: input.confirmationCode ?? null,
        startsAt: input.startsAt ?? null,
        endsAt: input.endsAt ?? null,
        originLocation: input.originLocation ?? null,
        destinationLocation: input.destinationLocation ?? null,
        currentState: input.currentState ?? {},
        tripHint: {
          destination: input.tripHint.destination ?? null,
          startsOn: input.tripHint.startsOn ?? null,
          endsOn: input.tripHint.endsOn ?? null,
        },
      };

      const trip = await findOrCreateTrip(deps.db, ctx.tenantId, parsed.tripHint);
      const result = await reconcileLeg(
        deps.db,
        trip.id,
        parsed,
        input.gmailMessageId,
        ctx.tenantId,
      );

      return {
        ok: true,
        result: {
          data: { trip, leg: result.leg, isNew: result.isNew },
        },
      };
    },
  };

  return [reconcileFromEmail];
}
