# Item categorization — design (TODO #76)

Status: brainstorm complete, Phase 1 ready to implement.

## Understanding lock

**What we're building.** A 5-kind taxonomy (`meeting` / `event` / `task` / `trip` /
`ooo`) for calendar items, with kind-aware UI cards. Each gcal item gets its
kind computed at sync time and stored on the row. Trips and OOO retain their
existing tables; their kind is implicit. The UI renders each kind with its own
card anatomy.

**Why.** Today every calendar item renders as the same generic FocusCard. An
HNWI experiences five different *kinds* of demand on attention (work, social,
errand, travel, unavailability), and the dossier should reflect that visually
so the right thing pops at a glance.

**Who.** The single HNWI user the EA module serves.

**Storage.**
- New column `kind text NOT NULL DEFAULT 'untagged'` on
  `executive_assistant__meetings` with CHECK constraint over
  `{'meeting', 'event', 'task', 'untagged'}`.
- New column `kind_locked boolean NOT NULL DEFAULT false` — true when the user
  has manually overridden. Every kind-write site MUST include
  `kind_locked = false` in its WHERE clause.
- Index `(tenant_id, kind)` for kind-filtered queries.
- Trip and OOO kinds are derived from source table membership, not stored.

**Classification path.**
- Rule-based first, runs at sync time after meeting + attendees upsert.
- Ambiguous → row stays `'untagged'`; Phase 3 LLM workflow resolves it
  asynchronously.
- User can right-click → change kind. Override sets `kind_locked = true` AND
  writes a memory note (`"user prefers X-style as Y"`) that the LLM tagger
  reads in its prompt.

**Explicit non-goals.**
- ❌ No change to brief prose voice (option B in the brainstorm clarifier).
- ❌ No change to conflict rules per kind (option C).
- ❌ No change to agent tool routing (option D).
- ❌ No Google Tasks API integration.
- ❌ No rename of `__meetings` table despite holding 3 kinds.

**Non-functional assumptions.**
- Rule classification at sync time adds <5 ms per item.
- LLM tagger/vetter (Phase 3) is async, target P95 <10 s.
- Scale: ~10–30 items/day; ~2–5 ambiguous/day requiring LLM.
- Reliability: if LLM fails, item stays untagged and renders as today's
  generic card.

## Decision log

| # | Decision | Alternatives | Why |
|---|---|---|---|
| 1 | 5-bucket unified taxonomy | 3 buckets; 3 + flags | Single typed stream across all surfaces |
| 2 | Rules-first, LLM fallback for unclear | LLM-always; rules-only | Cheap, fast, predictable; LLM is surgical |
| 3 | Tasks come from calendar entries | Google Tasks API; both | Avoids scope expansion |
| 4 | Verb-shape rule for event/task split | Has-location; attendee-presence | Matches "go here and do this" framing |
| 5 | Option A only (kind-aware cards) | + prose voice / conflicts / agent tools | Tighter scope; UI is the highest-value differentiator |
| 6 | At sync time, persisted on row | At read; hybrid side-table | Stable, predictable; no per-read cost |
| 7 | User can override, override seeds memory | No override; sticks per-item only | LLM learns user's preferences over time |
| 8 | text + CHECK constraint, not pg enum | Postgres ENUM type | Easier to evolve; type safety in app layer |
| 9 | `kind_locked` boolean separate from kind | Encode lock in kind value | Clean separation of classification vs lock |
| 10 | Phased horizontal shipping | Big-bang; vertical slices | Each phase independently verifiable |
| 11 | LLM vetter in Phase 3, not Phase 1 | Phase 1; Phase 2 | Phase 1 stays rule-pure, validated by SQL first |

## Phases

### Phase 1 — v0.4.28 (backend, rule-only)

In scope:

- Migration `XXX-add-item-kind.ts`: add `kind`, `kind_locked` columns + CHECK
  constraint + index. Down migration reverses cleanly.
- New module `packages/shared/src/classify.ts` exporting a pure
  `classify(input): { kind, confidence }` function.
- Rule order (first match wins):
  1. `conferenceLink` present → `('meeting', high)`
  2. Title contains a meeting keyword → `('meeting', high)`
     - `catchup`, `catch-up`, `sync`, `1:1`, `1on1`, `standup`, `stand-up`,
       `meeting`, `kickoff`, `retro`, `check-in`, `huddle`, `demo`, `weekly`,
       `daily`, `monthly`, `chat`
  3. Title starts with imperative verb **AND** no external attendees →
     `('task', high)`
     - `pick up`, `sign`, `review`, `buy`, `call`, `send`, `drop off`, `get`,
       `schedule`, `prepare`, `draft`, `write`, `read`, `order`, `renew`,
       `pay`, `file`, `submit`, `check`
  4. Has external attendees → `('event', high)`
  5. Otherwise → `('untagged', low)`
- Sync integration in `tools/calendar.ts`: after meeting + attendees upsert,
  call `classify()`. On `confidence === 'high'`, write `kind` only when
  `kind_locked = false`. On `'low'`, leave as `'untagged'`.
- Backfill in lifecycle post-migration step: pass over rows with
  `kind = 'untagged' AND kind_locked = false`, classify, update high-confidence
  matches. Idempotent.

Out of scope for Phase 1:

- No UI change (untagged + tagged rows still render via existing FocusCard).
- No agent change — `meetings.list` returns the new column but the agent
  doesn't use it yet.
- No LLM in path.

Tests (TDD, in order):

1. Rule 1 — video link → meeting (high).
2. Rule 2 — meeting keyword → meeting (high).
3. Rule 3 — imperative + solo → task (high).
4. Rule 3 negative — imperative + attendees → falls through to event.
5. Rule 4 — attendees, nothing else → event (high).
6. Rule 5 — nothing fires → untagged (low).
7. Integration: sync writes kind on insert.
8. Integration: sync respects `kind_locked`.
9. Integration: backfill is idempotent.

Ship verification: `select kind, count(*) from executive_assistant__meetings
group by kind` against a real tenant DB. Distribution should look right.

### Phase 2 — v0.4.29 (UI, kind-aware cards)

Replace `FocusCard` with a kind dispatcher. Build 5 card components:

- **MeetingCard** — attendees row, Join button, brief snippet, link.
- **EventCard** — location, who-with, relationship snippet.
- **TaskCard** — checkbox, duration pill, linked attachments.
- **TripCard** — leg list (flight, hotel, ground), pulls from trips table.
- **OOOCard** — range strip, auto-decline status, pulls from ooo table.

Untagged rows fall back to a neutral generic card.

Detailed design TBD when Phase 1 ships.

### Phase 3 — v0.4.30 (LLM workflow + user override + memory loop)

One async workflow with two modes sharing a caveman-mode prompt:

- **Tagger mode** — runs when `kind = 'untagged'`. Decides a kind from scratch.
- **Vetter mode** — runs when
  `kind in ('meeting', 'event', 'task') AND confidence = 'high' AND kind_locked = false`.
  Audits the rule's high-confidence outputs. Caveman prompt:
  ```
  Title: "..."
  Has video link: yes/no
  Has attendees: yes/no
  Location: "..."
  Rule says: KIND
  Reply only: ok | meeting | event | task
  ```

User override UI:

- Right-click on a card → "Change kind" → 4-option picker.
- On change: set `kind`, `kind_locked = true`, write memory note (e.g.,
  `"user prefers Dentist-style items as event"`).
- Tagger and vetter both read memory in their prompts.

Detailed design TBD when Phase 2 ships.

## Reference artifacts

- `docs/_brainstorm/76-categorization-options.html` — interactive demo of the
  four payoff options (only option A was chosen).
- `docs/_brainstorm/76-data-model.html` — visual walk-through of the 5 kinds,
  source-of-truth map, schema diff, data flow, and sample rows.
