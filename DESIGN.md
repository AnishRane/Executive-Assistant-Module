# Executive Assistant — Design

This document is the engineering reference for the EA module. It
consolidates the design decisions made during the brainstorming
sessions in May 2026. The visual companions are in `docs/`:

- [`docs/memory_explainer.html`](./docs/memory_explainer.html) —
  every structured entity, its attributes, PK / FK / UQ keys, and
  what each contextual memory tag holds.
- [`docs/feedback_loop_mockup.html`](./docs/feedback_loop_mockup.html) —
  the dossier UI, the six capture affordances, the memory & evidence
  page, and the conflict treatment.

> **Note on lag.** The HTML explainer documents 11 structured tables;
> two more (`conflicts`, `feedback_signals`) landed later in the
> brainstorm and are described in §4 of this document. The HTML
> explainer will be updated in Phase 0 of the build to include them
> with the same PK/FK treatment.

---

## 1. Purpose

A daily dossier surface for a high-net-worth individual, composed
by an autonomous BoringOS agent from calendar + email signal.
Reads more like a flow than a digest. Stays current through the day
via live deltas.

---

## 2. Architecture overview

```
┌─────────────────────────────────────────────────────────────┐
│  packages/web (PluginUI)                                    │
│  ──────────────────────────                                 │
│  /executive route in the host shell                         │
│  Timeline, drilldowns, memory & evidence page               │
└───────────────┬─────────────────────────────────────────────┘
                │ HTTP (typed API client from @boringos/ui)
                ▼
┌─────────────────────────────────────────────────────────────┐
│  packages/server — the Module                               │
│  ──────────────────────────                                 │
│  Tools:    meetings.*, trips.*, snapshots.*,                │
│            action_items.*, deltas.*, conflicts.*,           │
│            feedback_signals.*                               │
│  Routines: sync_calendar, sync_email_anchors,               │
│            morning_compose, delta_update,                   │
│            reflection_deeper                                │
│  Lifecycle: onInstall seeds agent + workflows + routines    │
│  Schema:   13 tables, prefixed executive_assistant__        │
└───────────────┬─────────────────────────────────────────────┘
                │
       ┌────────┴─────────┐                ┌─────────────────┐
       ▼                  ▼                ▼
┌──────────────┐  ┌──────────────────┐  ┌──────────────────┐
│ Postgres     │  │ MemoryProvider   │  │ connector-google │
│ (structured) │  │ (contextual)     │  │ (calendar+gmail) │
└──────────────┘  └──────────────────┘  └──────────────────┘
```

The agent runs as a CLI subprocess (Claude Code by default) per the
BoringOS execution model. Every read/write goes through tools.
Every tool dispatch lands in `tool_calls` (framework audit) and,
where relevant, in `feedback_signals` (legible feedback history).

---

## 3. The two memory stores

| Store | What it holds | Why |
|---|---|---|
| **Structured** — `executive_assistant__*` Postgres tables | Facts that must not drift: meeting times, flight numbers, confirmation codes, attendee identities, the verbatim text of an excerpt. | Typed columns; the database is the source of truth; recall has zero hallucination risk. |
| **Contextual** — BoringOS `MemoryProvider` (Hebbs by default) | The agent's evolving sense of David: preferences, voice, recurring people, places, cadence. | Paragraph-shaped; lets understanding grow without redesigning a schema for every soft-fact category. |

The agent only writes contextual memory at end-of-run reflection
points, never mid-composition. Updates **replace** the paragraph
under a tag, not append — the MemoryProvider keeps a version history
under the hood.

---

## 4. Structured schema

13 module-owned tables. All prefixed `executive_assistant__`, all
tenant-scoped (`tenant_id` column on every domain row, leading the
indexes). Full attribute lists with PK / FK / UQ are in
[`docs/memory_explainer.html`](./docs/memory_explainer.html); the
two recent additions (`conflicts`, `feedback_signals`) are
described in full below since they postdate the explainer.

| Table | Purpose |
|---|---|
| `snapshots` | One row per day — the frozen morning dossier. |
| `timeline_items` | Ordered entries on a snapshot's timeline. Polymorphic via `kind` + `ref_id`. |
| `meetings` | Calendar event + EA's layered understanding. |
| `meeting_attendees` | One row per external attendee per meeting (denormalised on purpose — same person, two meetings, two rows). |
| `trips` | A travel arc grouping multiple legs. |
| `trip_legs` | One reconciled segment — flight, hotel, ground. `current_state` is the latest truth; `source_message_ids` is the audit trail. |
| `email_anchors` | The audit log of which emails were read on behalf of which entity. |
| `thread_excerpts` | Verbatim quotes shown on meeting drilldowns. |
| `action_items` | Open items inferred from a meeting's thread. |
| `deltas` | Changes since the morning snapshot — drives the "changed since you last looked" UI. |
| `ooo_windows` | Out-of-office periods from calendar or auto-responder. |
| `conflicts` | Pairwise overlap rows. Three-way conflicts = three rows. **See §4.1.** |
| `feedback_signals` | David's explicit + implicit signals from the dossier UI. Feeds reflection. **See §4.2.** |

### 4.1 `executive_assistant__conflicts`

| Attribute | Key | What it's for |
|---|---|---|
| `id` | **PK** | Unique handle. |
| `tenant_id` | | Tenant scope. |
| `snapshot_id` | **FK** → `snapshots.id` | Which day's baseline this conflict is on. |
| `timeline_item_a_id` | **FK** → `timeline_items.id` | One side of the overlap. |
| `timeline_item_b_id` | **FK** → `timeline_items.id` | The other side. |
| `overlap_minutes` | | Severity hint for the UI. |
| `detected_at` | | When the reconciliation engine wrote this row. |
| `resolution_status` | | `unresolved` · `acknowledged` · `resolved_by_user` · `auto_resolved`. |
| `resolved_choice` | **FK** → `timeline_items.id` (nullable) | Which item David chose to take, when resolved. |

Pairwise rows handle three-way conflicts cleanly. Resolution earns
its place by giving the UI a stable handle and the agent a reason
to learn ("board-prep blocks are dispensable when client calls
collide").

### 4.2 `executive_assistant__feedback_signals`

| Attribute | Key | What it's for |
|---|---|---|
| `id` | **PK** | Unique handle. |
| `tenant_id` | | Tenant scope. |
| `signal_kind` | | `edited_brief` · `edited_attendee_bio` · `pinned_thread` · `dismissed_action` · `marked_unhelpful` · `conflict_resolved` · `opened_card` · `acknowledged_delta` · `dismissed_suggestion`. |
| `subject_kind` | | `meeting` · `trip_leg` · `snapshot` · `delta` · `action_item` · `conflict` · `attendee`. |
| `subject_id` | **FK** (polymorphic on `subject_kind`) | The thing the signal is about. |
| `value` | | `jsonb` — payload specific to the kind (e.g. the diff for `edited_brief`, chosen item id for `conflict_resolved`). |
| `created_at` | | When the signal was captured. |

The table earns its place by making the feedback loop **legible**.
Without it the same data is buried in `tool_calls` and querying
patterns from `tool_calls` is awkward.

---

## 5. Contextual memory tags

Stored under the EA agent's memory scope. Each tag holds one
coherent paragraph the agent rewrites when patterns shift.

| Tag | What it holds |
|---|---|
| `david.travel.preferences` | Airport buffer norms, seat preference, time-of-day avoidances. |
| `david.lodging.preferences` | Hotels he gravitates to in his common cities. |
| `david.voice` | Tone, sentence length, what he edits out. |
| `david.cadence` | When he reads the dossier; which cards he opens first. |
| `people.<normalised-email>` | The agent's accumulated read on a recurring attendee. |
| `company.<domain>` | The arc of David's relationship with a company. |

---

## 6. The feedback loop

Three input streams feed the reflection step:

1. **Direct signals from the UI** — dismissals, edits, pins,
   "less of this" marks, conflict resolutions. Six affordances
   defined; see `docs/feedback_loop_mockup.html` for the visual
   surface and `feedback_signals` table for the data shape.
2. **Indirect engagement** — which cards are opened, time-on-page,
   when the dossier is opened.
3. **Structured-data patterns** — repeated bookings, recurring
   attendees, durations that consistently differ from the calendar
   block.

Two reflection runs:

- **End-of-run** — short pass after every agent wake. "Anything new
  worth remembering?"
- **Weekly deep pass** — broader scan over a rolling 7-day window.
  Cross-references signals with structured patterns to update
  contextual memories.

---

## 7. Conflict handling

Conflicts arise as a cascading impact of a reschedule. Detection
logic lives in the reconciliation engine: any time a
`meetings.starts_at` or `trip_legs.starts_at` changes, the engine
runs a per-day overlap query and writes/updates `conflicts` rows.

**Surface principle:** the dossier doesn't pick a winner. Both
conflicting items stay on the timeline, both get a "Double-booked"
badge, both link to each other via the conflict-with note, and each
carries a "Take this · ask <X> to swap" affordance.

**Resolution principle:** the agent suggests, never acts (in v0.1).
"Take this" composes a draft message to the deprioritised attendee
but does not send. David's choice writes a `conflict_resolved` row
in `feedback_signals` and updates `conflicts.resolution_status` +
`conflicts.resolved_choice`.

**Buffer-thin back-to-backs** are a *separate softer signal* — own
badge, own elevation reason — and are not modelled as conflicts.
Lands in v0.2.

---

## 8. Pinned design decisions

Behaviours worth pinning so they don't drift through the build.

- **Current state on the surface; prior value carried by the delta.**
  Reconciled times replace stale ones in the dossier; the delta strip
  or badge carries `was X` so David never has to do arithmetic.
- **Verbatim over paraphrased excerpts.** The agent surfaces quotes
  as-is with attribution. Reduces hallucination risk on the
  human-facing surface.
- **Narrowly scoped email reading.** Two anchor rules — invite-thread
  match, travel sender-domain match. No full inbox sweep. Every email
  read logs to `email_anchors`.
- **Read-only briefing (v0.1).** No automated rescheduling, no
  outbound email, no calendar edits. Drafts compose but do not send.
- **No live flight-status polling.** Trip legs reconcile from a
  stream of airline/hotel emails (initial confirmation + check-in +
  gate changes + delays).
- **`snapshots` is daily; deltas accumulate against it.** The
  baseline freezes; changes through the day live in `deltas`,
  measured against the snapshot.
- **Contextual memory updates are end-of-run only.** The reflection
  step is separate from composition, so a write never changes the
  prose mid-compose.
- **Polymorphic FKs are explicit, not implicit.** Tables with
  polymorphic targets (`timeline_items.ref_id`,
  `email_anchors.bound_entity_id`, `feedback_signals.subject_id`,
  `conflicts.timeline_item_*_id`) carry a `<thing>_kind` discriminator
  column so the join target is never ambiguous.

---

## 9. Decision log

Each entry: decision · alternatives considered · why this option.

1. **Full Phase 1 EA scope (not "dossier-only").**
   - Alternatives: dossier-only, dossier-first-then-expand.
   - Chosen because the stack benefits from a single coherent morning
     surface; carving the EA into sub-modules creates a second
     integration seam for marginal gain.

2. **In-app only, no email delivery in v0.1.**
   - Alternatives: email-only, email + in-app, inbox-item + email,
     Drive file + email.
   - Chosen on explicit user direction. **Diverges from the master
     Phase 1 plan** which describes a morning email — to be
     reconsidered in v0.2 if David asks.

3. **Morning snapshot + live deltas (not pure snapshot or
   always-fresh).**
   - Snapshot freezes the narrative; deltas surface drift.
   - Avoids per-page-view agent cost while keeping the dossier
     useful through the day.

4. **Timeline + drilldown, with time-sensitive items elevated.**
   - Alternatives: pure timeline, sectioned dossier, single
     narrative page.
   - Hybrid lets the page glance well and dive deep when needed.
   - User-supplied refinement: time-sensitive items get a visual
     cue at the top — the three elevation triggers in §8.

5. **Narrowly scoped email anchors.**
   - Alternatives: anchors + heuristic relevance, full inbox sweep,
     anchors + user-pinned threads.
   - Chosen for smallest privacy blast radius and clearest audit
     story. Pin affordance shipped anyway as an escape hatch.

6. **Hybrid memory (structured + contextual).**
   - Alternatives: structured only, contextual only, deferred.
   - Structured guarantees the facts; contextual gives the surface
     its sense of knowing David. Both interfaces, agent writes
     through tools only.

7. **Three elevation triggers (imminence + change + agent judgment).**
   - Alternatives: imminence only, imminence + change,
     user-defined rules only.
   - Chosen so the agent reasons across the day, not just per item.
     Risk of false-positives mitigated by the "Less of this"
     affordance writing back as feedback.

8. **A dedicated `feedback_signals` table (not just `tool_calls`).**
   - Alternatives: scan `tool_calls` only; denormalised columns on
     subject tables.
   - Earns its place by making the feedback loop legible — David can
     ask "why does the agent think X?" and get a traceable answer.

9. **`conflicts` table with pairwise rows.**
   - Alternatives: a column on `timeline_items`, a delta-only model.
   - Pairwise rows handle three-way conflicts cleanly and give
     resolution a place to live with FKs to both items and the
     chosen one.

10. **Conflict resolution suggests, never acts (v0.1).**
    - Alternatives: agent reschedules automatically.
    - Consistent with read-only briefing scope. v0.2 lifts this once
      connectors gain send-capable affordances with proper review.

11. **Itinerary stack reconciled from a stream of emails (not only
    confirmations).**
    - Confirmation emails alone leave the trip stale when an
      airline pushes a gate change or delay.
    - `trip_legs.current_state` is rebuilt on every new
      sender-domain-matched email; `source_message_ids` keeps the
      audit trail.

12. **No provider-specific regex parsers; LLM extraction by a
    dedicated agent.** (Refactor during Phase 3.)
    - Original Phase 1b shipped regex parsers (`united.ts`,
      `marriott.ts`) plus a `TRAVEL_DOMAINS` allowlist. Brittle and
      provider-locked — every new airline / hotel chain needed a
      hand-tuned regex.
    - Replaced by the `ea-travel-lens` agent that wakes on
      BoringOS's built-in `triage.classified` event. Triage labels
      inbox items by *priority* (urgent | important | fyi | noise);
      the travel-lens agent then layers a *kind* decision on top
      using its LLM, extracts structured fields, and calls
      `trip_legs.reconcile_from_email` as a pure persistence path.
    - Trade-off: per-email LLM cost vs. zero maintenance and full
      provider coverage. For a high-net-worth single-tenant use
      case, this is the right side of the trade.
    - `trip_legs.reconcile_from_email` is now a pure persistence
      tool. The reconciler service and the partial-unique-index
      PNR-dedup invariant are unchanged. The only thing removed is
      the extraction step inside the module; that's now the
      agent's job, exactly the same way meeting briefs are.
    - Mirrors hebbs-crm's `email-lens` pattern: triage classifies
      generically, a domain-specific agent layers on the domain
      interpretation.

13. **Weather is fetched by the morning agent, not a separate routine;
    Open-Meteo is the provider; the block is dismissable.** (Phase 6.)
    - Original plan put weather in v0.2 as an explicit out-of-scope
      item. David asked for it post-Phase-6 with the framing "ship a v0
      and iterate on my feedback" — that framing shaped the design.
    - **Provider: Open-Meteo.** No API key, free for our usage volume,
      well-documented daily forecast endpoint, generous rate limits.
      We pass coordinates + a single date and store the response in
      `weather_snapshots.raw_payload` so any future re-summarisation
      can avoid a second API call.
    - **Location resolution is the agent's job, not the tool's.** The
      tool takes `(latitude, longitude, locationLabel, tz)`. The agent
      decides: trip leg destination if traveling on that date,
      otherwise `memory.recall('david.home_location')`, otherwise skip.
      Keeping location logic in the agent (not hardcoded server-side)
      lets it learn from David's feedback over time — e.g. "for late
      flights, give me weather at the *arrival* city, not origin."
    - **The agent does not always mention weather in the narrative.**
      Mild and clear → silent (the block above already shows high/low).
      Rain that affects commute, snow, extreme temps → mention.
    - **Dismiss/too-detailed/too-terse signals.** Three new feedback
      signal kinds (`weather_dismissed`, `weather_too_detailed`,
      `weather_too_terse`) plus a `weather` subject_kind. Daily and
      weekly reflection roll these into `david.weather.preferences`.
      A dismiss does *not* delete the row — the signal is what
      matters; the agent tunes on the pattern.
    - **First-cut scope (now superseded):** dry-bulb high/low, a
      single 6-bucket condition (clear/cloudy/fog/rain/snow/storm), a
      precipitation probability. Kept deliberately thin so we could
      ship and iterate.
    - **Iteration 1 expansion** (same morning, David flagged it as
      &ldquo;not precise enough&rdquo;): added apparent temperature
      (feels-like, both high and low), precipitation volume (mm),
      sustained wind speed + gusts (km/h), UV index max, sunrise +
      sunset. Replaced the 6-bucket condition with a dual model — the
      bucket stays for UI tokens and the agent's notable-check, but a
      granular WMO label (&ldquo;Heavy rain&rdquo;, &ldquo;Thunderstorm
      with slight hail&rdquo;, etc.) drives the human-readable display.
      Migration 005 was edited in place since no host had installed the
      thin version yet — additive forward migrations would have been
      over-engineering for unshipped code.
    - **Why the agent leans on chips, not prose, for the numbers.**
      The chip row carries the precise metrics — David can scan them.
      The narrative paragraph only mentions weather when it
      <i>changes the day</i>: feels-like ≥5°C off dry-bulb, gusts
      ≥40 km/h, ≥40% precip or ≥1 mm, UV ≥8, or any heavy / freezing
      condition. Mild + clear + calm stays silent.

---

## 10. Risks

| Risk | Mitigation |
|---|---|
| **Email-anchor matching is brittle on travel domains.** Some confirmation senders use ad-hoc subdomains. | Start with a known-good allowlist (UA, AA, DL, Marriott, Hyatt, Hilton, Hertz, Uber, …) and let the agent expand it as it sees recurring senders. |
| **PNR dedup fails on partial flights.** Some airline updates omit the PNR header. | `trip_legs.confirmation_code` is the primary dedup key; agent fuzzy-matches by leg date + flight number + provider as fallback. Source emails kept for audit. |
| **6 AM compose is slow / fails on busy mornings.** | The compose step splits: structured table queries are cheap and deterministic; `narrative_brief` is the only LLM call in the critical path. On failure, the dossier falls back to structured-only — no prose, but never a blank page. |
| **Contextual memory drifts via reinforcement.** A confirmed pattern that later flips can be slow to update. | Reflection step runs an "is this still right?" check on every recall, not just at write time. `memory.forget` is exposed via Settings. |
| **Conflict false-positives during routine reschedules.** Inbound meetings often shift within their own block without affecting others. | Conflict only writes when two items share at least one minute of overlap. Buffer-thin back-to-back is a separate softer signal (v0.2). |
| **HNWI privacy expectations.** The agent reads private email and calendars. | Every email read is logged in `email_anchors` with the entity it was read for. Audit query: "show me every email this agent has ever touched." `tool_calls` is the broader audit; both queryable from the host admin. |

---

## 11. Open questions (to revisit during the build)

These are the calls we deliberately didn't make in brainstorming;
they'll land naturally during the relevant phase.

- **Exact 6 AM time, time-zone handling for travel days.** Suggest:
  configurable per tenant; default 06:00 in David's home time zone;
  on travel days the compose runs in the destination time zone the
  night before, then again on arrival.
- **History retention.** How many days of past snapshots to keep in
  the timeline picker? Suggest: 90 days hot in the UI; infinite in
  the database (storage cost is negligible).
- **Settings UI scope.** Pause routines, edit elevation thresholds,
  manage forgotten tags, manage email-anchor allowlist. Ships in
  Phase 6 with the rest of the soak polish.
- **Cost budget per run.** What's the daily LLM ceiling for the EA
  agent before the framework's budget enforcement kicks in? Tune
  empirically once Phase 2 lands.
- **Provider taxonomy for `trip_legs.provider`.** Free-text vs.
  enum. Suggest: free-text for v0.1, with a normalisation pass at
  reflection time if patterns emerge.
