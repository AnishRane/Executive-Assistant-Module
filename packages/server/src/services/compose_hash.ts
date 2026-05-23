// Compose-input hash.
//
// Used by the always-fresh routine to skip waking the executive-
// assistant agent when nothing material has changed since the last
// compose. The "material" set:
//
//   - meetings today, identity + title + start/end + last_change_at
//   - unacknowledged deltas, by id
//   - unresolved conflicts, by id
//   - OOO windows today, by id + window
//   - weather snapshot fetched_at (changes when the data refreshed)
//
// Deterministic stringification: all arrays sorted by id; field order
// fixed; no trailing whitespace. SHA-256 of the resulting string.

import { createHash } from "node:crypto";
import { and, eq, gte, lte, isNull, inArray, ne } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { meetings } from "../schema/meetings.js";
import { deltas } from "../schema/deltas.js";
import { conflicts } from "../schema/conflicts.js";
import { oooWindows } from "../schema/ooo_windows.js";
import { snapshots } from "../schema/snapshots.js";
import { weatherSnapshots } from "../schema/weather_snapshots.js";

interface HashInputs {
  meetings: Array<{
    id: string;
    title: string;
    startsAt: string;
    endsAt: string;
    lastChangeAt: string | null;
  }>;
  deltaIds: string[];
  conflictIds: string[];
  oooWindows: Array<{ id: string; startsAt: string; endsAt: string }>;
  weather: { id: string; fetchedAt: string } | null;
}

/**
 * Compute the deterministic state hash for (tenant, forDate). The
 * caller is responsible for storing it on the snapshot row at compose
 * time and for re-computing at the next tick to compare.
 *
 * `forDate` is interpreted as the local-date boundary the host is
 * running in — meetings whose `starts_at` falls inside [00:00, 24:00)
 * of that date in the host's timezone are included. We approximate
 * via UTC bounds since the snapshots table itself keys on a calendar
 * date string; matching that contract is the simplest invariant.
 */
export async function computeStateHash(
  db: PostgresJsDatabase,
  tenantId: string,
  forDate: string, // YYYY-MM-DD
): Promise<string> {
  const inputs = await collectHashInputs(db, tenantId, forDate);
  return hashOf(inputs);
}

export async function collectHashInputs(
  db: PostgresJsDatabase,
  tenantId: string,
  forDate: string,
): Promise<HashInputs> {
  // Day window — 00:00 UTC to 23:59:59.999 UTC. We accept the timezone
  // approximation; if it matters David has the per-day hash bounded
  // by his calendar provider's own date semantics.
  const dayStart = new Date(`${forDate}T00:00:00.000Z`);
  const dayEnd = new Date(`${forDate}T23:59:59.999Z`);

  // 1. Meetings on this date for this tenant.
  const mtgRows = await db
    .select({
      id: meetings.id,
      title: meetings.title,
      startsAt: meetings.startsAt,
      endsAt: meetings.endsAt,
      lastChangeAt: meetings.lastChangeAt,
    })
    .from(meetings)
    .where(
      and(
        eq(meetings.tenantId, tenantId),
        gte(meetings.startsAt, dayStart),
        lte(meetings.startsAt, dayEnd),
      ),
    );

  // 2. Active snapshot(s) for this date — we need their ids to
  //    filter deltas/conflicts. There is at most one composed
  //    snapshot per (tenant, date) by the partial unique index.
  const snapRows = await db
    .select({ id: snapshots.id })
    .from(snapshots)
    .where(
      and(
        eq(snapshots.tenantId, tenantId),
        eq(snapshots.snapshotDate, forDate),
        eq(snapshots.status, "composed"),
      ),
    );
  const snapshotIds = snapRows.map((r) => r.id);

  // 3. Unacknowledged deltas attached to those snapshots.
  const deltaRows = snapshotIds.length
    ? await db
        .select({ id: deltas.id })
        .from(deltas)
        .where(
          and(
            inArray(deltas.snapshotId, snapshotIds),
            isNull(deltas.acknowledgedAt),
          ),
        )
    : [];

  // 4. Unresolved conflicts for this date (v0.4.14: conflicts are
  // keyed by tenant + for_date now, not snapshot_id).
  const conflictRows = await db
    .select({ id: conflicts.id })
    .from(conflicts)
    .where(
      and(
        eq(conflicts.tenantId, tenantId),
        eq(conflicts.forDate, forDate),
        ne(conflicts.resolutionStatus, "resolved_by_user"),
        ne(conflicts.resolutionStatus, "auto_resolved"),
      ),
    );

  // 5. OOO windows overlapping today.
  const oooRows = await db
    .select({
      id: oooWindows.id,
      startsAt: oooWindows.startsAt,
      endsAt: oooWindows.endsAt,
    })
    .from(oooWindows)
    .where(
      and(
        eq(oooWindows.tenantId, tenantId),
        gte(oooWindows.startsAt, dayStart),
        lte(oooWindows.startsAt, dayEnd),
      ),
    );

  // 6. Weather snapshot — the latest for this tenant + date.
  const wxRows = await db
    .select({
      id: weatherSnapshots.id,
      fetchedAt: weatherSnapshots.fetchedAt,
    })
    .from(weatherSnapshots)
    .where(
      and(
        eq(weatherSnapshots.tenantId, tenantId),
        eq(weatherSnapshots.forDate, forDate),
      ),
    );

  return {
    meetings: mtgRows.map((r) => ({
      id: r.id,
      title: r.title,
      startsAt: r.startsAt.toISOString(),
      endsAt: r.endsAt.toISOString(),
      lastChangeAt: r.lastChangeAt?.toISOString() ?? null,
    })),
    deltaIds: deltaRows.map((r) => r.id),
    conflictIds: conflictRows.map((r) => r.id),
    oooWindows: oooRows.map((r) => ({
      id: r.id,
      startsAt: r.startsAt.toISOString(),
      endsAt: r.endsAt.toISOString(),
    })),
    weather: wxRows[0]
      ? { id: wxRows[0].id, fetchedAt: wxRows[0].fetchedAt.toISOString() }
      : null,
  };
}

/**
 * Pure: deterministic stringify + sha256. Exported so tests can hit
 * it without standing up a DB.
 */
export function hashOf(inputs: HashInputs): string {
  const canonical = {
    meetings: [...inputs.meetings].sort((a, b) => a.id.localeCompare(b.id)),
    deltaIds: [...inputs.deltaIds].sort(),
    conflictIds: [...inputs.conflictIds].sort(),
    oooWindows: [...inputs.oooWindows].sort((a, b) => a.id.localeCompare(b.id)),
    weather: inputs.weather,
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}
