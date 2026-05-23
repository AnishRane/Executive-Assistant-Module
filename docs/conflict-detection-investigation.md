# Investigation — Conflict detection misses overlapping meetings

**Status:** Phase 1 complete (root cause identified, verified in code). Phase 2–4 not started.
**Date opened:** 2026-05-16
**Reporter:** Anish

## Symptom

Two Google Calendar events that clearly overlap are not surfaced as a conflict in the
EA dossier. No row in `executive_assistant__conflicts`, no card in the AttentionStrip.

**The specific pair that triggered the investigation:**

| Title                                    | Start  | End    |
| ---------------------------------------- | ------ | ------ |
| Catchup with Anish for Tech Discussion   | 16:30  | 17:30  |
| Dentist Appointment                      | 17:15  | 18:15  |

Overlap = 15 minutes (17:15–17:30). Trivial pair-wise math; should have produced one
row in conflicts table with `overlap_minutes = 15`. It did not.

## Verified Root Cause

**The conflict scan is wired to the wrong trigger.** `recomputeConflictsForSnapshot`
runs only as a side-effect of *mutations* to existing timeline_items — not as part
of dossier composition. So a snapshot can be (re)composed with overlapping items
and never be scanned for overlaps.

### Evidence (file:line — read with your own eyes)

`packages/server/src/services/delta_engine.ts:214` — the only function that writes
to `executive_assistant__conflicts`. Three callers, all in the same file:

| Line | Caller                | Gate                                  |
| ---- | --------------------- | ------------------------------------- |
| 79   | `detectMeetingDelta`  | `if (timeChanged)` (line 78)          |
| 128  | `detectTripLegDelta`  | `if (!timeChanged) return` (line 101) |
| 169  | `detectOooDelta`      | `if (!timeChanged) return` (line 148) |

There is **no other caller** anywhere in the codebase
(`grep -rn "recomputeConflictsForSnapshot" packages/server/src`).

### Compose path — no scan exists

`packages/server/src/skills/executive-assistant/SKILL.md`:
  - `requires:` block (lines 5–25) contains NO `conflicts.*` tool that detects
    overlaps. Only `conflicts.list` and `conflicts.resolve` exist as tools
    (`packages/server/src/tools/conflicts.ts:15, 47`).
  - Step 9 (lines 127–133) creates timeline_items, then jumps to step 10
    (reflection) and step 11 (mark task done). No scan trigger.

### Brand-new-meeting bypass

`packages/server/src/tools/meetings.ts:146-150`:

    const isChanged =
      existing.length > 0 &&
      (existing[0]!.startsAt.getTime() !== startsAt.getTime() ||
        existing[0]!.endsAt.getTime() !== endsAt.getTime() ||
        existing[0]!.title !== input.title);

A brand-new sync (existing.length === 0) returns `isChanged = false`, so the
`if (isChanged) { ... detectMeetingDelta(...) }` block at lines 185–207 is
skipped entirely. Same pattern in `packages/server/src/tools/ooo.ts:86, 100`.

### Combined effect

| Scenario                                                               | Scan fires? |
| ---------------------------------------------------------------------- | ----------- |
| Two meetings exist at compose time, never edited                       | ❌ never    |
| New meeting added after compose, never edited                          | ❌ never    |
| Existing meeting time-edited in Google Calendar after compose          | ✅ yes      |
| Existing meeting title-edited (no time change) after compose           | ✅ yes      |

The system is designed for continuous schedule watching (every-15-min cron on
both `calendar.sync_window` and `compose.maybe_create_task`). But the conflict
detection layer's trigger is incompatible with that intent.

## Architectural intent (user-stated)

> EA is someone who continuously looks at the schedule and dynamically
> re-composes the delta and provides updates on the dossier.

The sync and compose layers honor this. The conflict scan does not.

## Pipeline map (for context tomorrow)

1. `calendar.sync_window` (cron, every 15m) → `meetings.upsert_from_calendar`
   per event. Skips delta path on brand-new rows.
2. `compose.maybe_create_task` (cron, every 15m, hash-guarded) → if state
   hash differs, dispatch agent.
3. Agent runs SKILL.md steps 0–11 → creates timeline_items in step 9 → **no
   scan call**.
4. `recomputeConflictsForSnapshot` fires only when an existing meeting's
   start/end/title shifts on a subsequent sync tick.
5. UI: `useConflicts(snapshotId)` (`packages/web/src/hooks/useDossier.ts:299`)
   reads non-resolved conflicts; `AttentionStrip.tsx:72-80` renders only
   `unresolved`/`acknowledged` rows; component returns `null` when
   `totalIssues === 0`.

## Where to resume

Next session enters Phase 2 (pattern analysis) of `/superpowers:systematic-debugging`,
or directly into `/superpowers:brainstorming` to design the trigger placement.

### Open design questions to settle in Phase 2/3

1. **Where to trigger the scan.** Options:
   - (a) Add `conflicts.recompute_for_snapshot` tool, have SKILL.md step 9.5
     call it after timeline build. Agent-driven, deterministic body.
   - (b) Call `recomputeConflictsForSnapshot` directly from `snapshots.create`
     or `timeline_items.create` server-side. Side-effect of composition.
   - (c) Drop the `isChanged` gate in `meetings.upsert_from_calendar` and
     always scan on upsert (would also need a way to find today's snapshot
     for items that don't yet have a timeline_item).
   - Likely answer: (a) + (b), defense-in-depth.

2. **What to do for brand-new meetings synced after compose.** They get no
   timeline_item until the next compose tick. Should the snapshot-hash include
   them and trigger an immediate recompose, or should the dossier surface
   them via a different path?

3. **Test strategy.** Phase 4 requires a failing test first. Suggested:
   integration test that inserts two overlapping meetings, runs whatever
   the new trigger is, asserts a conflict row appears.

## Tasks (persisted via TaskCreate)

#61 ✅ Verify Gap A — no conflict scan at compose time
#62 ✅ Verify Gap B — brand-new meetings bypass delta
#63 ✅ Get user evidence on the missed overlap
#64 ✅ Inspect actual DB state for the day (skipped — host DB not reachable from dev)

Phase 4 tasks will be added after Phase 2/3 settles the design.
