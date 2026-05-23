// v0.4.14 conflict scan — server-side, no LLM, no snapshot dependency.
//
// Reads meetings / ooo_windows / trip_legs directly for a given date,
// computes pairwise overlaps, upserts into executive_assistant__conflicts.
// Fires on every calendar-side mutation (meetings.upsert_from_calendar,
// ooo.upsert_from_calendar, trip_legs.reconcile_from_email) and once
// from the install hook for today.
//
// This replaces the v0.4.11 timeline_items.create side-effect, which
// was wrong because it required the agent to compose a snapshot first.

import { and, eq, gte, lt, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { meetings } from "../schema/meetings.js";
import { oooWindows } from "../schema/ooo_windows.js";
import { tripLegs } from "../schema/trip_legs.js";
import { trips } from "../schema/trips.js";

// Optional realtime bus reference — passed through by callers that
// want subscribers notified of conflict changes. Keeping it as a
// parameter instead of importing deps avoids a circular import.
export interface ConflictPublisher {
  publish(event: {
    type: string;
    tenantId: string;
    data: Record<string, unknown>;
    timestamp: string;
  }): void;
}

export interface ScanItem {
  id: string;
  kind: "meeting" | "ooo" | "trip_leg";
  startsAt: Date;
  endsAt: Date | null;
}

export interface OverlapPair {
  aId: string;
  aKind: ScanItem["kind"];
  bId: string;
  bKind: ScanItem["kind"];
  overlapMinutes: number;
}

/**
 * Pure: given a flat list of items with start/end times, return all
 * overlapping pairs. Touching intervals (a.end == b.start) are NOT
 * overlaps. Pair canonicalised so the lex-smaller id is `a`. Items
 * with a null endsAt are skipped — overlap is undefined without it.
 */
export function findOverlapPairs(items: ScanItem[]): OverlapPair[] {
  const live = items.filter(
    (i): i is ScanItem & { endsAt: Date } => i.endsAt !== null,
  );
  const out: OverlapPair[] = [];
  for (let i = 0; i < live.length; i++) {
    for (let j = i + 1; j < live.length; j++) {
      const x = live[i]!;
      const y = live[j]!;
      if (x.startsAt < y.endsAt && y.startsAt < x.endsAt) {
        const overlapMs =
          Math.min(x.endsAt.getTime(), y.endsAt.getTime()) -
          Math.max(x.startsAt.getTime(), y.startsAt.getTime());
        const overlapMinutes = Math.max(0, Math.round(overlapMs / 60000));
        const [a, b] = x.id < y.id ? [x, y] : [y, x];
        out.push({
          aId: a.id,
          aKind: a.kind,
          bId: b.id,
          bKind: b.kind,
          overlapMinutes,
        });
      }
    }
  }
  return out;
}

/**
 * Recompute the conflict set for one tenant + date. Idempotent:
 * upserts overlapping pairs, auto-resolves pairs that no longer
 * overlap. Reads from the live entity tables — no snapshot required.
 *
 * `forDate` is interpreted as a UTC date string (YYYY-MM-DD). The
 * scan looks at entities whose startsAt falls in [forDate 00:00 UTC,
 * forDate+1 00:00 UTC).
 */
export async function recomputeConflictsForDate(
  db: PostgresJsDatabase,
  tenantId: string,
  forDate: string,
  publisher?: ConflictPublisher,
): Promise<void> {
  const dayStart = new Date(`${forDate}T00:00:00.000Z`);
  const dayEnd = new Date(dayStart.getTime() + 86_400_000);

  // Pull the day's entities
  const meetingRows = await db
    .select({
      id: meetings.id,
      startsAt: meetings.startsAt,
      endsAt: meetings.endsAt,
    })
    .from(meetings)
    .where(
      and(
        eq(meetings.tenantId, tenantId),
        gte(meetings.startsAt, dayStart),
        lt(meetings.startsAt, dayEnd),
      ),
    );

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
        lt(oooWindows.startsAt, dayEnd),
      ),
    );

  // trip_legs has no tenant column; join through trips
  const legRows = await db
    .select({
      id: tripLegs.id,
      startsAt: tripLegs.startsAt,
      endsAt: tripLegs.endsAt,
    })
    .from(tripLegs)
    .innerJoin(trips, eq(trips.id, tripLegs.tripId))
    .where(
      and(
        eq(trips.tenantId, tenantId),
        gte(tripLegs.startsAt, dayStart),
        lt(tripLegs.startsAt, dayEnd),
      ),
    );

  const items: ScanItem[] = [
    ...meetingRows.map((m) => ({
      id: m.id,
      kind: "meeting" as const,
      startsAt: m.startsAt,
      endsAt: m.endsAt,
    })),
    ...oooRows.map((o) => ({
      id: o.id,
      kind: "ooo" as const,
      startsAt: o.startsAt,
      endsAt: o.endsAt,
    })),
    ...legRows
      .filter((l): l is { id: string; startsAt: Date; endsAt: Date | null } => l.startsAt !== null)
      .map((l) => ({
        id: l.id,
        kind: "trip_leg" as const,
        startsAt: l.startsAt,
        endsAt: l.endsAt,
      })),
  ];

  const pairs = findOverlapPairs(items);

  // Upsert each overlapping pair. Re-open any auto_resolved row that
  // now overlaps again.
  for (const p of pairs) {
    await db.execute(sql`
      INSERT INTO executive_assistant__conflicts
        (tenant_id, for_date, ref_a_kind, ref_a_id, ref_b_kind, ref_b_id, overlap_minutes, resolution_status)
      VALUES
        (${tenantId}, ${forDate}, ${p.aKind}, ${p.aId}::uuid, ${p.bKind}, ${p.bId}::uuid, ${p.overlapMinutes}, 'unresolved')
      ON CONFLICT (tenant_id, for_date, ref_a_id, ref_b_id) DO UPDATE
        SET overlap_minutes = EXCLUDED.overlap_minutes,
            ref_a_kind = EXCLUDED.ref_a_kind,
            ref_b_kind = EXCLUDED.ref_b_kind,
            resolution_status = CASE
              WHEN executive_assistant__conflicts.resolution_status = 'auto_resolved'
                THEN 'unresolved'
              ELSE executive_assistant__conflicts.resolution_status
            END,
            detected_at = now()
    `);
  }

  // Auto-resolve any rows for this date that no longer match a live pair.
  if (pairs.length === 0) {
    await db.execute(sql`
      UPDATE executive_assistant__conflicts
         SET resolution_status = 'auto_resolved'
       WHERE tenant_id = ${tenantId}
         AND for_date = ${forDate}
         AND resolution_status = 'unresolved'
    `);
    if (publisher) {
      try {
        publisher.publish({
          type: "executive-assistant:conflicts.changed",
          tenantId,
          data: { forDate, pairCount: 0 },
          timestamp: new Date().toISOString(),
        });
      } catch {
        // ignore
      }
    }
    return;
  }

  const keepValues = sql.join(
    pairs.map((p) => sql`(${p.aId}::uuid, ${p.bId}::uuid)`),
    sql`, `,
  );
  await db.execute(sql`
    UPDATE executive_assistant__conflicts
       SET resolution_status = 'auto_resolved'
     WHERE tenant_id = ${tenantId}
       AND for_date = ${forDate}
       AND resolution_status = 'unresolved'
       AND (ref_a_id, ref_b_id) NOT IN (${keepValues})
  `);

  // v0.4.20: notify subscribers (best-effort).
  if (publisher) {
    try {
      publisher.publish({
        type: "executive-assistant:conflicts.changed",
        tenantId,
        data: { forDate, pairCount: pairs.length },
        timestamp: new Date().toISOString(),
      });
    } catch {
      // Realtime publish must never break the scan.
    }
  }
}
