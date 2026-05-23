# Executive Assistant — UI/UX Refactor Design

> **Status:** confirmed, ready for implementation
> **Brainstormed:** 2026-05-14 (via `/brainstorming` skill — full chat log preserves the dialogue)
> **Companion prototypes:**
> - [`day_view_prototypes.html`](./day_view_prototypes.html) — four signal-placement options A/B/C/D
> - [`resolve_flow_prototype.html`](./resolve_flow_prototype.html) — five-state resolution walk-through for Option D
> **Supersedes:** the current dossier-style UI shipped in EA v0.3.1

---

## 1. Understanding summary

EA's web surface (`executive-assistant/packages/web`) is refactored from its current **HNWI dossier paradigm** — serif body, cream paper, brown accent, prose narrative headline, single chronological timeline — into a **shell-native day-and-week-ahead experience** built from named components. The morning compose agent is also re-timed from a 06:00-only firing to a **15-minute always-fresh** cadence with a state-hash skip-guard.

**Why this exists:**

- EA fights the workspace aesthetic. A user moving across shell ↔ CRM ↔ EA experiences three different products. The shell uses Inter/paper/amber; CRM uses Inter/white/blue; EA uses serif/cream/brown — basically the opposite of both reference repos in every dimension that matters.
- The dossier's prose-headline + chronological list doesn't answer *"what should I pay attention to right now"* as cleanly as a Now/Next/Later cognitive structure.
- The 06:00-only narrative makes EA feel stale by 11 AM. The underlying tables refresh every 15 min via the routine layer; the agent's prose should match that freshness.

**Who it serves:**

- **Primary:** David — HNWI, single-tenant, ~10-min morning read at 06:00 IST, but also dipping in throughout the day.
- **Secondary:** any future tenant running EA inside their BoringOS host.

**Key constraints:**

- Shell tokens are non-negotiable: Inter 14 px, paper `#F8F6F1`, amber accent `#B45309`, 248 px sidebar, no top bar, no shadows at rest, no serif anywhere.
- Outbound (send email, modify calendar) routes through BoringOS's existing `google.gmail.*` and `google.calendar.*` tools — EA does not ship its own outbound surface.
- Reschedule capability is auto-detected per-meeting via Google Calendar's permission metadata.
- Data source stays the same: 15-min routines polling Google for both calendar and email. No switch to native `inbox_items` reads; no BoringOS-side calendar layer.
- Narrative regenerates every 15 min, **but only when the input state hash changes**.

**Explicit non-goals:**

- ❌ No native data-layer consolidation (Decision #11).
- ❌ No new top-level nav routes — keep Today / History / Memory / Settings.
- ❌ No autopilot — every outbound action goes through one-click human review.
- ❌ No new EA schema changes — UI + timing refactor only.
- ❌ No serif typography anywhere.

---

## 2. Decision log

| # | Decision | Alternatives considered | Why this option |
|---|---|---|---|
| 1 | Adopt BoringOS shell tokens verbatim (paper canvas `#F8F6F1`, amber accent `#B45309`, Inter 14 px) | Hybrid identity (shell rhythm, EA-specific accent); align with CRM blue instead; preserve serif/cream interior with shell chrome | Maximum continuity inside the host; user moving shell ↔ CRM ↔ EA experiences one product |
| 2 | Day view = **Now / Next / Later** focus blocks | Chronological timeline (current EA); time-of-day slabs (Morning/Midday/Afternoon/Evening); hour-grid calendar view | Attention-triage cognitive model; matches "components plural" framing; most distinct from the old dossier |
| 3 | Week view = **7-day strip** (Mon→Sun tiles) | Curated highlights feed; vertical day-grouped list; strip + highlights together | Glanceable; consistent with day-view triage philosophy; supports click-to-expand into Now/Next/Later |
| 4 | Route = **single screen** — week strip header + day body | Separate routes (/executive + /executive/week); tabs on /executive; collapsible strip behind a toggle | Most cohesive; no nav tax to switch days; strip permanently anchors orientation |
| 5 | Narrative = dedicated **Day brief card** alongside Now/Next/Later | Thin one-sentence header; remove from UI entirely; show only on demand (hover) | Preserves agent voice with proper weight; gets a dedicated home in the layout |
| 6 | Signal placement = **Option D** (inline badges + attention strip) | Option A all-embedded; Option B separate right-rail panels; Option C hybrid supporting cards | Clean default + a single bar that elevates only when there's actionable work; whole-day signals still surface in week-strip markers |
| 7 | Resolve autonomy = **Review-then-send** (one-click apply on a pre-filled preview) | Full autopilot; always hand-edit; draft-only (no autonomous send ever) | Balances velocity with reversibility; David sees the outbound before it leaves but the cognitive load is one click |
| 8 | Permission = **calendar-level, auto-detected per-meeting** | EA-level global Settings toggle; both (cal action + EA autonomy separately); per-organizer trust list | Simplest; no new settings page; matches Google Calendar's own permission model; v0.2 stays scoped |
| 9 | Nav = **Today + History + Memory + Settings** (unchanged) | Drop History (page back via week strip); drop Memory (fold into Settings); two-item minimal | Each surface has a distinct job; week-strip pagination isn't a substitute for an archive |
| 10 | Drilldown = **right-side drawer (~420 px)** | Inline expansion; separate page route; modal overlay | Keeps day-view context visible; matches CRM entity-detail idiom; supports closing without losing scroll |
| 11 | Data source = **stay as-is** (EA continues polling Google directly) | Switch email to native `inbox_items`; build native calendar layer in BoringOS; hybrid iCal-from-inbox parsing | Redundancy is small (one extra API call/15 min); cross-repo work not warranted; keeps refactor focused |
| 12 | Compose timing = **always-fresh, every 15 min, hash-guarded** | 06:00 only static; 06:00 + auto re-read on material change; 06:00 + on-demand "Re-read" button | Matches data freshness; skip-on-unchanged-hash keeps LLM cost contained; preserves morning canonical regeneration as a natural subset of the 15-min cadence |

---

## 3. Assumptions

1. Shell + CRM design language is stable through the duration of this refactor.
2. Existing EA tools (`meetings.set_brief`, `conflicts.resolve`, `deltas.acknowledge`, `meetings.upsert_from_calendar`, `weather.fetch_for_date`, etc.) remain the data layer; UI changes do not reach into them.
3. The compose agent's input state can be hashed cheaply — concretely: `sha256(JSON.stringify({ meetingIds, lastChanges, deltaIds, conflictIds, weatherUpdatedAt, oooWindowIds }))`. If hash matches the previous snapshot's recorded hash, the agent skips the LLM call entirely.
4. The single routine `EA Compose (every 15 min)` replaces both `EA Morning Compose (06:00)` and the previous always-on routines for the narrative path. 06:00 is naturally one of the 15-min ticks.
5. Week strip tile content (meeting count, lead item, markers) is computed at render time via a new `executive-assistant.snapshots.week_strip` read tool, not persisted.
6. When Google Calendar's event metadata indicates David cannot edit an event (`organizer.self !== true && guestsCanModify !== true`), the Resolve UI's "Reschedule" button is hidden; only "Decline with context" is offered.
7. The shell renders the nav chrome via its own `linkClasses` renderer; EA supplies the slot components but never the navigation frame.
8. v0.2 outbound (auto-send + reschedule via Calendar API) uses BoringOS's `google.gmail.send_email` / `google.gmail.reply_email` / `google.calendar.update_event` tools as documented in the connector audit.

---

## 4. Design overview

### 4.1 Visual identity

Verbatim adoption of BoringOS shell tokens — see the [day view prototypes](./day_view_prototypes.html) for the rendered result.

| Token | Value | Used for |
|---|---|---|
| `--paper` | `#F8F6F1` | Canvas background (dot grid at 24 × 24 px, `rgba(11,18,32,0.045)`) |
| `--paper-warm` | `#F1ECE3` | Hover fills, nav active fill |
| `--surface` | `#FFFFFF` | Card backgrounds |
| `--border` | `#E6E1D6` | All borders (1 px solid) |
| `--border-subtle` | `#EFEAE0` | Row dividers, section separators |
| `--ink` | `#0B1220` | Primary text, headings |
| `--ink-2` | `#2A3447` | Secondary text |
| `--muted` | `#5C6478` | Labels, timestamps |
| `--accent` | `#B45309` | Primary buttons, active nav, badges, focus rings |
| `--accent-tint` | `rgba(180,83,9,0.10)` | Selected-row tint, ring-2 on focus |
| `--green` | `#4F6B57` | Success states |
| `--red` | `#F43F5E` | Destructive, conflict signal |
| `--amber-soft` / `--rose-soft` | `#FBEEE2` / `#F4DCD7` | Inline-badge fills for delta / conflict |

**Typography:** Inter (Google Fonts) for everything. JetBrains Mono for time tokens, identifiers, keyboard shortcut hints. Base 14 px / 1.55 line-height. Section labels `text-[11px] font-semibold uppercase tracking-wide text-muted`.

### 4.2 Information architecture

```
/executive                       ← single screen (week strip + day body)
/executive/history               ← past dossiers archive
/executive/memory                ← agent's read on David
/executive/settings              ← system status (read-only in v0.2)
/executive/meetings/:id          ← hidden; drilldown drawer renders here
/executive/trips/:id             ← hidden; drilldown drawer renders here
```

The shell provides nav chrome. EA contributes 4 visible `navItems` + 2 hidden detail routes (drawer surfaces).

### 4.3 The day-view composition

Stacked top-to-bottom inside `/executive`:

```
┌──────────────────────────────────────────────────────────────────────┐
│  Screen header: "This week" + date                                   │
├──────────────────────────────────────────────────────────────────────┤
│  Week strip — 7 day tiles (today highlighted with amber ring)        │
├──────────────────────────────────────────────────────────────────────┤
│  Day brief card — agent's narrative paragraph                        │
├──────────────────────────────────────────────────────────────────────┤
│  Attention strip — visible only if any unresolved deltas/conflicts   │
├──────────────────────────────────────────────────────────────────────┤
│  Weather strip — visible only if weather data exists                 │
├──────────────────────────────────────────────────────────────────────┤
│  Now card — current/imminent item (highlighted amber ring)           │
├──────────────────────────────────────────────────────────────────────┤
│  Next card — the next item after Now                                 │
├──────────────────────────────────────────────────────────────────────┤
│  Later today — compact list of remaining items                       │
└──────────────────────────────────────────────────────────────────────┘
```

All meetings, trip legs, OOO windows embed inline at their time. Deltas/conflicts attach as inline badges on the affected card. Whole-day signals (active trip, today's OOO) get markers in the week strip's day tile.

### 4.4 Component vocabulary

Six top-level components on the day view:

| Component | Purpose | Key data |
|---|---|---|
| `WeekStrip` | 7-day glance + day-navigation | `meetings`, `trip_legs`, `ooo_windows`, all grouped by date |
| `DayBriefCard` | The agent's narrative paragraph | `snapshots.narrative_brief` (current day's row) |
| `AttentionStrip` | Counts unresolved deltas + conflicts; expands into resolution panel | `deltas` (acknowledged_at is null), `conflicts` (resolution_status = 'unresolved') |
| `WeatherStrip` | Today's weather summary | `weather_snapshots` |
| `FocusCard` (used for Now and Next) | Single-item card with title, attendees, brief excerpt, inline badges | `meetings` / `trip_legs` / `ooo_windows` |
| `LaterList` | Compact list of remaining same-day items | Same sources as FocusCard |

Plus the drawer-rendered drilldowns:

| Component | Purpose |
|---|---|
| `MeetingDrawer` | Full attendee list, brief editor, verbatim email excerpts, action items |
| `TripDrawer` | All legs in order, confirmation codes, source emails |

### 4.5 Resolve flow

When the Attention Strip is clicked, it expands inline into a panel with one row per unresolved signal. See [`resolve_flow_prototype.html`](./resolve_flow_prototype.html) for the five-state walk-through.

**Per-issue affordances:**

- **Delta** ("Klein moved up 1h") — one-click "Got it" button. Acknowledges via `deltas.acknowledge`. Row collapses to a strike-through "acknowledged + Undo" line.
- **Conflict** ("Klein × Standup overlap") — "Resolve →" button expands the row into a focus state:
  - Two side-by-side **pick cards** (Keep Klein / Keep Standup).
  - Optional **draft message box** for the side being bumped — pre-filled in David's voice.
  - Three action buttons: `Apply choice + save draft`, `Apply choice only`, `Cancel`.
  - If David is the meeting organizer AND has calendar edit permission → "Apply + send + reschedule" is added (review-then-send model).

**Skip-when-not-permitted:** If Google Calendar metadata says David can't edit the event, the reschedule button is hidden and only the decline-with-context path is offered.

### 4.6 Compose timing

Routine: `*/15 * * * *` (`EA Compose · every 15 min · always-fresh`). Single routine replaces today's `EA Morning Compose (06:00)`. Each tick:

```
1. Read current state: meetings, trip_legs, ooo_windows, deltas, conflicts, weather
2. Compute state hash = sha256(JSON.stringify({
     meetingIds + lastChanges,
     deltaIds (unacknowledged),
     conflictIds (unresolved),
     oooWindowIds,
     weatherUpdatedAt
   }))
3. Read prior snapshot's stored hash (new column: snapshots.state_hash)
4. If hash matches → SKIP. No LLM call. Update snapshots.last_checked_at.
5. If hash differs → wake the executive-assistant agent. Agent regenerates
   narrative_brief, refreshes per-meeting briefs, recomputes timeline items.
   Store new hash on the snapshot row.
```

**Cost:** ~96 ticks/day; LLM fires only when state has actually shifted. Expected real-world LLM calls per day: 5–20 depending on calendar churn.

### 4.7 Drawer behaviour

420 px wide, slides in from the right edge with a translate-X transition (200 ms). Day-view stays visible at full width on the left, optionally dimmed (`opacity 0.95`). Drawer closes via X button, ESC key, or click outside. Closing does not lose day-view scroll position.

Drawer content (single column):

- Title + organizer + meeting metadata
- Inline brief editor (textarea; saves via `meetings.set_brief` on blur)
- Attendees list with bios from MemoryProvider
- Verbatim email excerpts
- Action items (each with dismiss affordance)
- Per-item deltas + conflict info (if any)

---

## 5. Implementation roadmap (proposed)

This roadmap is for reference; explicit phase planning happens at implementation handoff.

### Phase A — Foundation (no behavior change)

- Replace EA's CSS tokens with shell tokens (`packages/web/src/index.css`)
- Replace serif body with Inter; remove cream paper variables
- Restyle existing components (`Badge`, `Timeline`, `EmptyState`, etc.) to shell idioms

### Phase B — Day view restructure

- New `WeekStrip` component + read tool `snapshots.week_strip`
- New `FocusCard` component (replaces `TimelineItem` for Now/Next)
- New `LaterList` component
- New `AttentionStrip` component (collapsed + expanded states)
- New `DayBriefCard` component
- Restyled `WeatherStrip` to match new design
- `Today.tsx` rewritten to compose these

### Phase C — Resolve flow

- Inline expansion of `AttentionStrip` → resolution panel
- Per-issue rows (delta with Got-it; conflict with pick cards + draft)
- Wire to existing `deltas.acknowledge` + `conflicts.resolve` tools
- New `drafts.compose_for_conflict` tool that uses `google.gmail.*` to save a draft (Apply + draft path)
- New `meetings.reschedule_via_google` tool (Apply + send path) — only when calendar metadata permits

### Phase D — Drawer drilldown

- New `MeetingDrawer`, `TripDrawer` components
- Replace `/executive/meetings/:id` route with route-as-drawer pattern (route still exists for direct linking; renders inside the drawer overlaying Today)

### Phase E — Compose timing

- Add `snapshots.state_hash` column (migration 006)
- Modify the compose agent's task to hash inputs and skip when unchanged
- Replace `EA Morning Compose (06:00)` routine with `EA Compose (*/15 * * * *)`
- Test that 06:00 still produces the expected canonical regeneration

### Phase F — Polish

- Empty states: quiet day, weekend, pre-OAuth
- Per-card secondary action affordances (Snooze / Open in Cal)
- History page redesign
- Memory page redesign
- Settings page chrome adoption

Version: this lands as **EA v0.4.0** (minor — UI refactor + compose-timing change, no breaking schema or tool surface changes).

---

## 6. Open questions deferred to implementation

These are design-level decisions that flow from the locked decisions; flagging so they're not forgotten:

- Exact wording on the inline badges (e.g. "↑ Moved from 10:30" vs "Moved earlier" vs other phrasings)
- Quiet-day visual treatment (show Now/Next/Later with empty-state copy, or hide them entirely?)
- Pre-OAuth state on `/executive` — show empty Now/Next/Later or a "connect Google" hero?
- Drawer width on smaller viewports (mobile is currently out of scope; what about laptop 1280px?)
- The `state_hash` algorithm — exact field list and serialization order
- Whether the `EA Morning Compose` routine entry should be renamed in DB (cosmetic; can stay as legacy name)
- History page reframing — date-paged Today, or a separate list view?
- Memory page — does the new design affect what's shown there?

---

## 7. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Always-fresh compose runs LLM 96×/day even with hash-guard | Hash function must be cheap + state-stable; monitor LLM call rate post-deploy; if >30 calls/day per tenant, tighten hash inputs |
| Drawer + day-view layout breaks on viewport widths between 1100–1500 px | Day-view max-width 1100 px (per CRM idiom); drawer is overlay (not pushed-aside), so no layout reflow |
| Resolve UI's "Apply + send + reschedule" makes real calendar/email writes | Review-then-send: David clicks the button → outbound goes; no autopilot. Audit row in `tool_calls` for every send. v0.2 only when calendar permission allows |
| Hash-guard fails to detect a material change (e.g. someone manually edits a brief in DB) | The brief editor on the drawer calls `meetings.set_brief` which updates `last_change_at`; hash includes `lastChanges`; manual DB edits are out of scope |
| Cross-tenant: future tenants don't speak David's voice | The narrative is tenant-scoped via memory tags (`david.voice` → `<tenant>.voice` pattern); reflection writes update per-tenant |

---

## 8. Companion artifacts

- **[`day_view_prototypes.html`](./day_view_prototypes.html)** — canonical visual spec for the day view. Four options A/B/C/D rendered with shell tokens. Option D is the chosen design.
- **[`resolve_flow_prototype.html`](./resolve_flow_prototype.html)** — canonical visual spec for the conflict resolution flow. Five states: idle → expanded → mid-resolution → conflict focus → all clear.
- **[`feature_audit.html`](./feature_audit.html)** — pre-existing capability audit. Continues to be the source-of-truth for what EA does and doesn't do; this design doc supersedes the visual portion.
- **[`DESIGN.md`](../DESIGN.md)** — the original EA engineering design doc. Decisions 1–13 still apply; this refactor adds decisions 14–25 (referenced by # in the Decision Log above, renumbered to global 1–12 in this document for clarity).

---

*End of design document. Implementation handoff is the next step.*
