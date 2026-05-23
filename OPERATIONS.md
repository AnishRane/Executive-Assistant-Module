# Executive Assistant — Operations

This document is the runbook for soaking and operating the module
on a live BoringOS host. It assumes:

- BoringOS host is running with embedded Postgres or a configured
  `DATABASE_URL`.
- The Google connector (`@boringos/connector-google`) is wired and
  David has OAuthed his account.
- The EA module has been installed onto David's tenant via
  `POST /api/admin/modules/install`.

## The five soak days — what "green" looks like

End-of-Month-1 milestone (per `Personal_AI_Stack_Phase1_Plan.md`):
five consecutive working days where David opens the dossier and the
agent didn't need a manual nudge.

Each soak day is green when **all of the following** hold:

1. `EA Morning Compose` ran at 06:00 and a row exists in
   `executive_assistant__snapshots` with status `composed` and a
   non-empty `narrative_brief`.
2. The day's `executive_assistant__timeline_items` cover every
   calendar event David held in his work hours.
3. At least one meeting's `executive_assistant__meetings.brief` is
   populated (proves the agent did per-meeting framing, not just
   the top-line narrative).
4. The 15-min sync routines kept `agent_runs.status = 'success'` —
   no failed routine runs sitting in the admin UI.
5. The morning dossier rendered without errors at `/executive` in
   the BoringOS shell.

## What to watch

### Each morning (~10 min review)

- Open `/executive`. Read the dossier.
- Check the timeline matches David's actual day.
- Open one meeting drilldown. The brief should read like a paragraph
  framing the conversation, not a list.
- If a meeting moved later in the day, refresh after 60 seconds and
  confirm a Changed badge appears.

### Once per soak day (~5 min)

- BoringOS admin UI → Runs. Filter by `agent_runs` for the
  `executive-assistant` and `ea-travel-agent` roles. All should be
  `success`. Any `failed` or `skipped` rows: open and read the
  error.
- BoringOS admin UI → Routines. Confirm:
  - `EA Sync Calendar (every 15 min)` is `active` (was `paused` at
    install; activation workflow flipped it on Google connect)
  - `EA Scan Meeting Threads (every 15 min)` is `active`
  - `EA Morning Compose (06:00 daily)` is `active`
  - `EA Weekly Reflection (Mon 06:30)` is `active`

### End of the soak window

- Open `/executive/memory` and read the feedback signals stream.
  After a week of normal use, expect 5–20 rows depending on how
  much David interacted.
- On the Monday inside the window, `EA Weekly Reflection` ran. The
  agent should have called `memory.remember` at least once if there
  were any consistent patterns. Confirm via the admin Runs view.

## Failure modes — what to do

### "No dossier composed yet" on the Today page after 06:05

- Most likely the `executive-assistant` agent didn't get seeded at
  install time because the tenant didn't have a Claude runtime or a
  root agent yet. Re-install the module (admin UI → Modules →
  Reinstall). `onInstall` will re-seed.
- If still missing: check `agent_runs` for a failed Morning Compose
  run. Read the error. Common cause: `memory.recall` returning an
  error from an un-configured `MemoryProvider`. The agent should
  fall back per SKILL.md — if it doesn't, that's a SKILL.md fix.

### Calendar events not appearing in the timeline

- Confirm `EA Sync Calendar` routine is `active`, not `paused`.
- If `paused` and Google IS connected: the activation workflow
  didn't fire. Manually flip the routine to `active` in the admin UI.
- Confirm Google connector has the calendar scope. Re-OAuth if not.

### A meeting moved in Google but the dossier still shows the old time

- The sync routine runs every 15 min; the UI polls every 60s. Worst
  case is ~16 min from the move to the dossier reflecting it.
- After 20 min: check the admin Runs view for a failed
  `EA Sync Calendar` run. Read the error.
- The `meetings.upsert_from_calendar` tool only updates
  `last_change_at` when title/start/end actually shift — if the
  meeting moved but other tools were called first, check
  `executive_assistant__meetings.updated_at` to confirm the row was
  touched.

### Trip leg not appearing after a flight confirmation

- The `ea-travel-agent` only runs on `triage.classified` events.
  Confirm BoringOS's built-in triage module is installed (default
  install on every tenant). (Renamed from `ea-travel-lens` in
  v0.4.9 — older logs / agent_runs rows still carry the old role.)
- Confirm the inbox item exists: `inbox_items` table should have a
  row for the message.
- If `metadata.triage` is populated but `metadata.eaTravelLens` is
  absent, the travel agent hasn't woken on this item. Check
  `agent_runs` for failed runs of the `ea-travel-agent` (or
  `ea-travel-lens` on installs that pre-date v0.4.9).
- If `metadata.eaTravelLens.decision = "not_travel"`, the agent
  read the email and decided it wasn't travel. Read the email
  yourself; if the agent was wrong, that's a SKILL.md tuning input
  (more examples needed, decision criteria refined).

### Memory & evidence page is empty after a week

- The page reads from `executive_assistant__feedback_signals`.
- If David hasn't interacted (no brief edits, no conflict
  resolutions, no action item dismissals), there's nothing to show.
  Check by inspecting the table directly.
- If David HAS interacted: confirm the relevant tools are wired —
  `meetings.set_brief` from the Edit affordance, `conflicts.resolve`
  from the resolution flow, etc.

## Manual interventions to AVOID during soak

The soak only counts as green if there were no manual interventions.
The following count as breaking the soak:

- Manually un-pausing routines that didn't get unpaused by the
  activation workflow.
- Manually re-running a failed compose because the agent didn't
  re-wake.
- Editing rows in the database to fix what should have been a tool
  call.

If any of these are needed, the soak resets. Note the cause and fix
it in the code — that's the value of a strict soak.

## After the soak

When five working days are clean:

1. Commit + tag the module at `v0.1.0`.
2. Record the demo: ~3 minutes showing the morning dossier, a
   live delta + conflict, a brief edit, and the Memory & evidence
   page after the week of use.
3. Hand off to David. Phase 2 of the master plan (Lucy / financial
   surface) starts at end of Month 1.
