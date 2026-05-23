// Trip + trip_leg reconciliation primitives.
//
// Shared between trip_legs.reconcile_from_email (single-email entry
// point) and any future bulk path. Pure async functions of (db,
// tenantId, parsedLeg, messageId) — no tenant cross-contamination
// by construction.
//
// The PNR-dedup invariant lives here: when parsed.confirmationCode is
// present, we look up an existing leg by (trip_id, kind, confirmation_code)
// and merge into it rather than creating a duplicate. Backed at the DB
// layer by the partial unique index ea__trip_legs_pnr_uniq.

import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { eq, and, sql } from "drizzle-orm";
import { trips } from "../schema/trips.js";
import { tripLegs } from "../schema/trip_legs.js";
import { detectTripLegDelta } from "./delta_engine.js";
import type { ParsedLeg } from "../types.js";

type TripRow = typeof trips.$inferSelect;
type TripLegRow = typeof tripLegs.$inferSelect;

export async function findOrCreateTrip(
  db: PostgresJsDatabase,
  tenantId: string,
  hint: ParsedLeg["tripHint"],
): Promise<TripRow> {
  if (hint.destination) {
    const conds = [
      eq(trips.tenantId, tenantId),
      sql`LOWER(${trips.destination}) = LOWER(${hint.destination})`,
    ];
    // Date-overlap window of ±7 days. NULL trip dates are treated as
    // "open-ended" and always match.
    if (hint.startsOn) {
      conds.push(
        sql`(${trips.endsOn} IS NULL OR ${trips.endsOn} >= ${hint.startsOn}::date - INTERVAL '7 days')`,
      );
    }
    if (hint.endsOn) {
      conds.push(
        sql`(${trips.startsOn} IS NULL OR ${trips.startsOn} <= ${hint.endsOn}::date + INTERVAL '7 days')`,
      );
    }
    const existing = await db
      .select()
      .from(trips)
      .where(and(...conds))
      .limit(1);
    if (existing.length > 0) {
      return existing[0]!;
    }
  }

  const label =
    hint.destination ??
    (hint.startsOn ? `Trip on ${hint.startsOn}` : "Untitled trip");
  const [trip] = await db
    .insert(trips)
    .values({
      tenantId,
      label,
      destination: hint.destination,
      startsOn: hint.startsOn,
      endsOn: hint.endsOn,
    })
    .returning();
  return trip!;
}

export interface ReconcileResult {
  leg: TripLegRow;
  isNew: boolean;
}

export async function reconcileLeg(
  db: PostgresJsDatabase,
  tripId: string,
  parsed: ParsedLeg,
  messageId: string,
  /** Optional — when present, the delta engine fires on existing-row updates. */
  tenantId?: string,
): Promise<ReconcileResult> {
  // Dedup invariant: same (trip_id, kind, confirmation_code) → same leg.
  // Without a confirmation_code we can't dedup deterministically; insert
  // a fresh row. Reconciliation can attach later when a PNR arrives.
  let existing: TripLegRow[] = [];
  if (parsed.confirmationCode) {
    existing = await db
      .select()
      .from(tripLegs)
      .where(
        and(
          eq(tripLegs.tripId, tripId),
          eq(tripLegs.kind, parsed.kind),
          eq(tripLegs.confirmationCode, parsed.confirmationCode),
        ),
      )
      .limit(1);
  }

  if (existing.length > 0) {
    const old = existing[0]!;
    const sources = (old.sourceMessageIds ?? []) as string[];
    const newSources = sources.includes(messageId)
      ? sources
      : [...sources, messageId];
    const mergedState = {
      ...(old.currentState ?? {}),
      ...parsed.currentState,
    };

    const [updated] = await db
      .update(tripLegs)
      .set({
        // Only overwrite when the new email carries the field — never
        // erase a previously-known value with a null.
        startsAt: parsed.startsAt ? new Date(parsed.startsAt) : old.startsAt,
        endsAt: parsed.endsAt ? new Date(parsed.endsAt) : old.endsAt,
        originLocation: parsed.originLocation ?? old.originLocation,
        destinationLocation:
          parsed.destinationLocation ?? old.destinationLocation,
        currentState: mergedState,
        sourceMessageIds: newSources,
        lastReconciledAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(tripLegs.id, old.id))
      .returning();

    if (tenantId) {
      try {
        await detectTripLegDelta(
          db,
          tenantId,
          updated!.id,
          { startsAt: old.startsAt, endsAt: old.endsAt },
          {
            startsAt: updated!.startsAt,
            endsAt: updated!.endsAt,
            kind: updated!.kind,
          },
        );
      } catch (err) {
        console.warn(
          `[reconcileLeg] delta detection failed:`,
          err instanceof Error ? err.message : err,
        );
      }
    }

    return { leg: updated!, isNew: false };
  }

  const [inserted] = await db
    .insert(tripLegs)
    .values({
      tripId,
      kind: parsed.kind,
      confirmationCode: parsed.confirmationCode,
      provider: parsed.provider,
      startsAt: parsed.startsAt ? new Date(parsed.startsAt) : null,
      endsAt: parsed.endsAt ? new Date(parsed.endsAt) : null,
      originLocation: parsed.originLocation,
      destinationLocation: parsed.destinationLocation,
      currentState: parsed.currentState,
      sourceMessageIds: [messageId],
      lastReconciledAt: new Date(),
    })
    .returning();
  return { leg: inserted!, isNew: true };
}
