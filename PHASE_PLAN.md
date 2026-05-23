# Executive Assistant — Phase Plan

This module ships in **seven phases**. Each phase is small,
observable, and ends with something David can see (or a test
that passes). **No phase starts until the previous one is demoably
done.**

Total scope: roughly Week 3 of David's master Phase 1 plan
(approximately 7–10 working days at AI-velocity build pace).

> **Naming note.** "Phase 0..6" in this document refers to the
> *build phases of this module*. The "Phase 1" and "Phase 2"
> referenced in the master `Personal_AI_Stack_Phase1_Plan.md` are
> a different axis — that's the overall stack plan covering all
> five agents. Keep them separate in conversation.

---

## Phase 0 — Foundation

**Goal:** workspace ready, module manifest valid, the framework
registers the module without crashing.

**Ships:**
- pnpm workspace with three packages: `server`, `shared`, `web`
- `packages/server/module.json` + `createExecutiveAssistantModule`
  factory exported from `packages/server/src/index.ts`
- Empty `migrations[]`, empty `tools[]`, empty `skills[]` on the
  module manifest
- Module registers on host boot; install lifecycle no-ops cleanly
- `pnpm typecheck` and `pnpm -r build` both pass

**Done when:** `app.module(createExecutiveAssistantModule)` boots
on a fresh BoringOS host and EA appears in `/api/admin/modules` as
installable.

---

## Phase 1 — Read-only ingestion

**Goal:** the structured tables fill themselves from Google. No
agent yet — just plumbing.

**Ships:**
- Schema + migrations for: `snapshots`, `timeline_items`,
  `meetings`, `meeting_attendees`, `trips`, `trip_legs`,
  `email_anchors`, `ooo_windows`. (Conflicts, deltas, excerpts,
  action_items, feedback_signals come later.)
- `EA Sync Calendar` routine — every 15 min — reads upcoming
  events via `connector-google`, upserts `meetings` +
  `meeting_attendees` + `ooo_windows`.
- `EA Scan Meeting Threads` routine — every 15 min —
  deterministic match: Gmail messages whose `thread_id` equals a
  known meeting's thread become `email_anchors` rows of kind
  `meeting_invite`. **No content parsing.**
- Read tools: `meetings.list`, `meetings.get`, `trips.list`,
  `trips.get`, `ooo.list`.
- Pure persistence tools: `email_anchors.scan_meetings`,
  `email_anchors.bind`, `trip_legs.reconcile_from_email` (accepts
  already-extracted leg fields; PNR dedup via the partial unique
  index).

> **Architecture note.** Travel-email *extraction* (deciding kind,
> reading the body, pulling out PNR / dates / route) is **not** in
> Phase 1b. Provider-locked regex parsers were removed in favour
> of LLM extraction by the `ea-travel-lens` agent that Phase 2
> seeds. See DESIGN.md decision log entry 12.

**Done when:** drop a calendar event and a meeting-thread email.
Within 15 min the meeting row exists and the email is anchored to
it. Travel-leg ingestion is verified in Phase 2 once the
`ea-travel-lens` agent is running against the `triage.classified`
event stream.

---

## Phase 2 — Morning composition

**Goal:** the agent wakes at 6 AM, composes the day's dossier,
freezes a `snapshots` row.

**Ships:**
- Two agent roles seeded by lifecycle:
  - `executive-assistant` — the morning composer (cron-driven).
  - `ea-travel-lens` — the travel-email reader (event-driven on
    `triage.classified`). Replaces the regex parsers.
- Two `SKILL.md` files — one per role.
- `EA Morning Compose` workflow + 06:00 daily routine.
- `EA Travel Lens on triage` workflow — event-driven, no routine.
  Fires whenever BoringOS's built-in triage classifies an inbox
  item.
- Morning-compose tools: `snapshots.create`, `timeline_items.create`,
  `meetings.set_brief`, `thread_excerpts.create`,
  `action_items.create`.

**Done when:** at 06:05 there's a `snapshots` row with a
`narrative_brief`, a coherent set of `timeline_items`, and a
brief on each surfaced meeting. The brief reads like a paragraph,
not a list. And: drop a flight confirmation email — within one
triage tick the `ea-travel-lens` agent has decided kind, extracted
PNR/dates/route, and a `trip_legs` row exists with the email's
message id in `source_message_ids`.

---

## Phase 3 — Dossier UI

**Goal:** David can open `/executive` and read today's dossier.

**Ships:**
- `PluginUI` for EA: nav item, today route, drilldown routes
  (`/executive/meetings/:id`, `/executive/trips/:id`).
- React components: day header, timeline, meeting drilldown card,
  trip drilldown card, OOO block.
- HNWI aesthetic to match the mockup: serif body, ample whitespace,
  restraint. Tailwind tokens follow `docs/feedback_loop_mockup.html`.
- History view (date picker on past snapshots).
- The "Memory & evidence" route is stubbed but empty (Phase 5
  populates it).

**Done when:** open the host at `/executive`, see today's dossier
rendered to match the mockup, click a meeting card to enter the
drilldown, click back to return to the timeline.

---

## Phase 4 — Live deltas + conflict detection

**Goal:** the dossier stays current through the day without
manual refresh.

**Ships:**
- `deltas` + `conflicts` tables + migrations.
- Reconciliation engine: on every `email_anchors` write or
  `sync_calendar` tick, diff against the snapshot and write
  `deltas` rows.
- Conflict detection: on any meeting time change or trip leg time
  change, re-run the per-day overlap query, write/update
  `conflicts` rows (pairwise).
- A `delta_update` routine (every 5 min) wakes the agent only if
  there are unprocessed changes worth narrating.
- UI: deltas render as badges + strips per the mockup. Conflict
  items get the conflict treatment (red rail, "Double-booked"
  badge, conflict-with note, "Take this · ask <X> to swap"
  affordance).
- Realtime push to the UI via the framework's SSE bus, so the
  page updates without a refresh.

**Done when:** reschedule a meeting in Google to overlap an
existing meeting. Within 5 min the dossier shows the conflict on
both items with the right badges and the right narrative delta
strip on the moved meeting's drilldown.

---

## Phase 5 — Feedback capture + reflection

**Goal:** preferences get learned, not declared.

**Ships:**
- `feedback_signals` table + migration.
- All six affordances from the mockup wired up:
  - ① edit brief
  - ② edit attendee bio
  - ③ pin thread
  - ④ dismiss action item
  - ⑤ mark delta unhelpful
  - ⑥ conflict resolution
- One tool per signal kind, each writing both a `tool_calls` row
  (audit) and a `feedback_signals` row (legible).
- **End-of-run reflection step** — runs after every agent wake:
  "is anything from this run worth remembering?" Updates contextual
  memory via `memory.remember`.
- **Weekly `reflection_deeper` routine** — broader scan over the
  rolling 7-day window of `feedback_signals` + structured-data
  patterns. Writes/updates contextual memories.
- The "Memory & evidence" page from the mockup — populated.

**Done when:** edit a brief, see the diff land in
`feedback_signals` within seconds. After a week of normal use,
open Memory & evidence and find `david.voice` reflecting the
edits in its evidence trail.

---

## Phase 6 — Soak + polish

**Goal:** five consecutive working days where David opens the
dossier and the agent didn't need a nudge.

**Ships:**
- Performance pass: N+1 audit on the dossier page, Postgres index
  review on the hottest queries.
- Resilience pass: every external call (Google API, MemoryProvider)
  falls back gracefully without breaking the morning compose. A
  failed compose still produces a structured-only snapshot with no
  prose — David never sees a blank page.
- Seed default contextual memory tags with placeholder content so
  the agent has somewhere to write before pattern-stable evidence
  exists.
- Settings page (pause routines, manage email-anchor allowlist,
  forget contextual memory tags).
- Demo recording.

**Done when:** five consecutive working days of unattended
operation. All `agent_runs` green. The dossier consistently
generated by 06:05. No manual interventions needed across the
soak window.

---

## Out of scope for v0.1

These are deliberately not in any phase above. They land in v0.2
or are deferred to Phase 2 of the master plan.

- **Email delivery** of the morning dossier. v0.1 is in-app only.
- **Reply assistance + draft sending.** The conflict-resolution
  "ask X to swap" affordance composes a draft but does not send.
  Sending arrives in v0.2 with proper review controls.
- **Live flight-status polling** (FlightAware, AviationStack, etc).
  Trip leg status comes from email notifications only.
- **Weather as a top-line block.** May land in v0.2 once we know
  what level of detail David actually wants.
- **Pre-meeting briefs from prior meetings.** Placeholder until
  Meetings Assistant (Week 4 of master plan) lands. v0.1 shows
  "no prior meeting on file."
- **Cross-tenant / multi-user features.** EA respects `tenant_id`
  everywhere (multi-tenant by architecture) but ships no
  shared-team affordances.
- **Mobile-optimised UI.** Desktop / laptop first.
- **Buffer-thin back-to-back warnings.** A softer signal than
  conflicts; v0.2.

---

## Dependencies between phases

```
Phase 0 ──► Phase 1 ──► Phase 2 ──► Phase 3 ──► Phase 4 ──► Phase 5 ──► Phase 6
                                                  │             │
                                                  └─────────────┴── these two can overlap
                                                                    once Phase 4's data
                                                                    model is locked
```

Phase 4 and Phase 5 can interleave once Phase 4's schema (`deltas`,
`conflicts`) is in place — UI work on Phase 4 deltas and tool work
on Phase 5 feedback don't block each other. Everything else is
strictly sequential.
