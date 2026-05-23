// Detection of deltas + recomputation of conflicts. Called by the
// write tools (meetings.upsert_from_calendar, trip_legs reconciler,
// ooo.upsert_from_calendar) AFTER they've persisted the change.
//
// Two invariants kept here:
//   1. timeline_items.starts_at/ends_at are denormalised copies of the
//      underlying entity's times. When the entity moves, we update the
//      timeline_item too — that's how the dossier surface stays current
//      (DESIGN.md pinned decision 1). Without the update, the timeline
//      shows the snapshot-time order even after a reschedule.
//   2. Conflicts are pairwise rows over a snapshot's timeline_items.
//      We canonicalise the pair (a < b) so the unique index dedupes.
//      On a recompute, items that no longer overlap have their existing
//      conflict row's status set to 'auto_resolved'.
//
// All functions are best-effort — a failure here MUST NOT roll back
// the parent write. The tool wraps the call in a try/catch.

import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { and, eq } from "drizzle-orm";
import { snapshots } from "../schema/snapshots.js";
import { timelineItems } from "../schema/timeline_items.js";
import { deltas } from "../schema/deltas.js";

/**
 * Called after meetings.upsert_from_calendar applies a real change.
 * Detects on-snapshot timeline items pointing at this meeting and
 * writes deltas + recomputes conflicts.
 */
export async function detectMeetingDelta(
  db: PostgresJsDatabase,
  tenantId: string,
  meetingId: string,
  prior: { startsAt: Date; endsAt: Date; title: string },
  current: { startsAt: Date; endsAt: Date; title: string },
): Promise<void> {
  const items = await findTimelineItemsForEntity(db, tenantId, "meeting", meetingId);
  if (items.length === 0) return; // not on any composed snapshot

  const timeChanged =
    prior.startsAt.getTime() !== current.startsAt.getTime() ||
    prior.endsAt.getTime() !== current.endsAt.getTime();

  for (const item of items) {
    if (timeChanged) {
      await db
        .update(timelineItems)
        .set({ startsAt: current.startsAt, endsAt: current.endsAt })
        .where(eq(timelineItems.id, item.id));
    }

    await db.insert(deltas).values({
      snapshotId: item.snapshotId,
      timelineItemId: item.id,
      deltaKind: timeChanged ? "rescheduled" : "meeting_updated",
      summary: timeChanged
        ? summariseReschedule(prior, current)
        : `Meeting updated · "${current.title}"`,
      meta: timeChanged
        ? {
            fromStartsAt: prior.startsAt.toISOString(),
            toStartsAt: current.startsAt.toISOString(),
            fromEndsAt: prior.endsAt.toISOString(),
            toEndsAt: current.endsAt.toISOString(),
            fromTitle: prior.title,
            toTitle: current.title,
          }
        : { fromTitle: prior.title, toTitle: current.title },
    });

    // v0.4.14: conflict scan no longer fires here. It runs directly
    // on meetings.upsert_from_calendar via recomputeConflictsForDate.
  }
}

/**
 * Called after the reconciler updates an existing trip_leg.
 */
export async function detectTripLegDelta(
  db: PostgresJsDatabase,
  tenantId: string,
  tripLegId: string,
  prior: { startsAt: Date | null; endsAt: Date | null },
  current: { startsAt: Date | null; endsAt: Date | null; kind: string },
): Promise<void> {
  const items = await findTimelineItemsForEntity(db, tenantId, "trip_leg", tripLegId);
  if (items.length === 0) return;

  const timeChanged =
    (prior.startsAt?.getTime() ?? null) !== (current.startsAt?.getTime() ?? null) ||
    (prior.endsAt?.getTime() ?? null) !== (current.endsAt?.getTime() ?? null);

  if (!timeChanged) return;

  for (const item of items) {
    await db
      .update(timelineItems)
      .set({
        startsAt: current.startsAt ?? item.startsAt,
        endsAt: current.endsAt,
      })
      .where(eq(timelineItems.id, item.id));

    const deltaKind =
      current.kind === "flight" ? "flight_delayed" : "trip_leg_updated";

    await db.insert(deltas).values({
      snapshotId: item.snapshotId,
      timelineItemId: item.id,
      deltaKind,
      summary: summariseLegShift(prior, current),
      meta: {
        fromStartsAt: prior.startsAt?.toISOString() ?? null,
        toStartsAt: current.startsAt?.toISOString() ?? null,
        fromEndsAt: prior.endsAt?.toISOString() ?? null,
        toEndsAt: current.endsAt?.toISOString() ?? null,
      },
    });

    // v0.4.14: conflict scan no longer fires here.
  }
}

/**
 * Called after ooo.upsert_from_calendar applies a change.
 */
export async function detectOooDelta(
  db: PostgresJsDatabase,
  tenantId: string,
  oooWindowId: string,
  prior: { startsAt: Date; endsAt: Date },
  current: { startsAt: Date; endsAt: Date },
): Promise<void> {
  const items = await findTimelineItemsForEntity(db, tenantId, "ooo", oooWindowId);
  if (items.length === 0) return;

  const timeChanged =
    prior.startsAt.getTime() !== current.startsAt.getTime() ||
    prior.endsAt.getTime() !== current.endsAt.getTime();
  if (!timeChanged) return;

  for (const item of items) {
    await db
      .update(timelineItems)
      .set({ startsAt: current.startsAt, endsAt: current.endsAt })
      .where(eq(timelineItems.id, item.id));

    await db.insert(deltas).values({
      snapshotId: item.snapshotId,
      timelineItemId: item.id,
      deltaKind: "ooo_updated",
      summary: "Out-of-office window updated",
      meta: {
        fromStartsAt: prior.startsAt.toISOString(),
        toStartsAt: current.startsAt.toISOString(),
        fromEndsAt: prior.endsAt.toISOString(),
        toEndsAt: current.endsAt.toISOString(),
      },
    });

    // v0.4.14: conflict scan no longer fires here.
  }
}

// ─── helpers ────────────────────────────────────────────────────

interface TimelineItemRow {
  id: string;
  snapshotId: string;
  startsAt: Date;
  endsAt: Date | null;
}

async function findTimelineItemsForEntity(
  db: PostgresJsDatabase,
  tenantId: string,
  kind: "meeting" | "trip_leg" | "ooo",
  refId: string,
): Promise<TimelineItemRow[]> {
  // We only act on composed snapshots — superseded ones are history.
  const rows = await db
    .select({
      id: timelineItems.id,
      snapshotId: timelineItems.snapshotId,
      startsAt: timelineItems.startsAt,
      endsAt: timelineItems.endsAt,
    })
    .from(timelineItems)
    .innerJoin(snapshots, eq(snapshots.id, timelineItems.snapshotId))
    .where(
      and(
        eq(snapshots.tenantId, tenantId),
        eq(snapshots.status, "composed"),
        eq(timelineItems.kind, kind),
        eq(timelineItems.refId, refId),
      ),
    );
  return rows;
}

// v0.4.14: recomputeConflictsForSnapshot removed. Conflict detection
// no longer hangs off snapshots/timeline_items. The new scan lives in
// services/conflict_scan.ts (recomputeConflictsForDate) and runs as
// a side-effect of every meetings.upsert_from_calendar / ooo.upsert
// / trip_legs.reconcile_from_email, plus the install hook.

// ─── summary text builders ──────────────────────────────────────

function summariseReschedule(
  prior: { startsAt: Date; endsAt: Date },
  current: { startsAt: Date; endsAt: Date },
): string {
  const fromMs = prior.startsAt.getTime();
  const toMs = current.startsAt.getTime();
  const deltaMin = Math.round((toMs - fromMs) / 60000);
  if (deltaMin === 0) return "Meeting end time changed";
  const direction = deltaMin < 0 ? "earlier" : "later";
  const abs = Math.abs(deltaMin);
  return `Meeting moved ${abs} min ${direction} · now ${fmtHm(current.startsAt)} (was ${fmtHm(prior.startsAt)})`;
}

function summariseLegShift(
  prior: { startsAt: Date | null; endsAt: Date | null },
  current: { startsAt: Date | null; endsAt: Date | null; kind: string },
): string {
  if (!prior.startsAt || !current.startsAt) return "Trip leg updated";
  const fromMs = prior.startsAt.getTime();
  const toMs = current.startsAt.getTime();
  const deltaMin = Math.round((toMs - fromMs) / 60000);
  if (deltaMin === 0) return "Trip leg updated";
  const direction = deltaMin < 0 ? "earlier" : "later";
  const label = current.kind === "flight" ? "Flight" : current.kind === "hotel" ? "Hotel" : "Leg";
  return `${label} moved ${Math.abs(deltaMin)} min ${direction} · now ${fmtHm(current.startsAt)} (was ${fmtHm(prior.startsAt)})`;
}

function fmtHm(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// Silence "unused imports" if we tighten signatures later.
