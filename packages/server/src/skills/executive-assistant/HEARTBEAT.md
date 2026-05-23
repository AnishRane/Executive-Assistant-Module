# HEARTBEAT.md — Executive Assistant Operating Rhythm

Run this checklist on every wake. Do not skip steps.

## 1. Identify the wake mode

Read the task description first. Determine which of the four modes you're in:

- **Morning compose.** First wake of the day. No prior snapshot for today. Compose from scratch.
- **Refresh.** A prior snapshot exists for today, but state has shifted since (calendar edited, OOO added, conflict appeared). Recompose only what changed; reuse what didn't.
- **User-triggered.** The user opened `/executive` or hit refresh. Same as a refresh wake but treat the user as actively reading.
- **Reactive.** Triggered by an event (connector connected, travel email received). The task description tells you what changed.

The wake mode determines your output's opening tone and whether you write a full brief or a delta.

## 2. Pull the deterministic signal

Always read the structured data first, before writing anything. The server has already done the math. Use what it gives you, verbatim.

- Today's meetings, OOO spans, trips, conflicts.
- Day-shape signal from `compose.day_signal`.
- Display name, current location, home location.

If a required input returns empty or null, name it and degrade gracefully. Do not invent a substitute.

## 3. Compose the dossier

Follow SKILL.md for the exact procedure and output structure. The persona has already told you who you are. The skill tells you what you do.

## 4. Save

Persist what you wrote:

- Day Brief: `snapshots.create` + `timeline_items.create` per item.
- Meeting Prep Brief: `meetings.set_brief` for each meeting.

If you skipped a section due to missing data, the snapshot still saves with what you produced.

## 5. Reflect into memory

Before closing, write any inferred signal back to memory:

- If the user edited a prior brief, infer what shifted in their voice or cadence and update `user.voice` / `user.cadence`. Include a one-line acknowledgment in the next brief ("Noticed you prefer shorter people summaries, updated.").
- If you learned something about an attendee or company today, update `people.<email>` or `company.<domain>`.
- Never write to memory what you can't point to.

## 6. Close

- Post one short comment to the task: composed time + meeting count + anything notable (e.g. "Composed in 38s. 4 meetings, 1 conflict, 1 travel-email flagged by Triage.").
- Mark the task done: `framework.tasks.patch({ taskId, status: "done" })`.

## When something fails

- A tool call returns an error: read the error. If it's a validation failure, the input shape was wrong. Check SKILL.md's tool cheatsheet for the exact call shape.
- A required signal is unavailable (no calendar, no location): name it in the brief, skip the dependent section, continue.
- You do not know what to write: stop. Save what you have. Comment what's missing. Do not fill space with invention.
