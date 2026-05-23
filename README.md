# Executive Assistant

> A BoringOS module that watches calendar and email and composes a
> daily dossier that reads less like a digest and more like a flow.

This is module **1 of 5** in the Personal AI Stack (Phase 1 of David
Hauser's personal cockpit). It is the morning surface every other
agent in the stack eventually feeds into.

## What it is

An autonomous Executive Assistant for a high-net-worth individual.
Each morning the agent reads the day's calendar items and the
narrowly-scoped emails tied to them — invite threads, travel
confirmations, hotel updates — reconciles a stream of confirmation
emails into a coherent itinerary per leg, and composes a dossier.
Through the day it watches for changes (reschedules, delays, new
context emails, conflicts) and surfaces them as live deltas on the
same timeline.

The dossier lands in-app at `/executive` on the BoringOS host.
**No email delivery in v0.1** — this is a deliberate divergence from
the master Phase 1 plan; see [`DESIGN.md`](./DESIGN.md) §9.

## Design principles

- **The dossier never shows a stale state.** When something changes,
  the current value replaces the old one on the surface, and the
  prior value rides along inside a delta or badge. David never has
  to read two timestamps and guess which is right.
- **Hybrid memory.** Facts that must not drift (times, flight numbers,
  confirmation codes) live in module-owned Postgres tables. The
  agent's evolving sense of David (preferences, recurring people,
  tone) lives in BoringOS's `MemoryProvider`. Two stores, used for
  different things.
- **Narrowly scoped email reading.** Every email the agent touches
  is bound to a known anchor — an invite thread or a travel
  sender-domain match. Anything else, by construction, is not read.
- **Verbatim over paraphrased.** Quotes from email threads appear
  word-for-word with attribution. The agent does not summarise email
  content into its own voice — that's where drift happens.
- **Suggest, never act (in v0.1).** Conflict-resolution affordances
  compose drafts but do not send. Outbound action lands in v0.2.

## How it's organised

```
executive-assistant/
├── README.md           This file.
├── PHASE_PLAN.md       Seven build phases, what each ships, definition of done.
├── DESIGN.md           Schema, decisions, principles. The engineering reference.
├── docs/
│   ├── memory_explainer.html      Hybrid memory model — entities, attributes, PK/FK keys.
│   └── feedback_loop_mockup.html  Dossier UI, six capture affordances, memory & evidence, conflict treatment.
└── packages/           Created in Phase 0 of the build.
    ├── server/         The BoringOS Module — tools, schema, lifecycle, SKILL.md.
    ├── shared/         DTOs and constants shared with web.
    └── web/            The dossier page — PluginUI mounted in the BoringOS shell.
```

## Stack

Same shape as `hebbs-crm`:

- Hono on Node ≥ 22, TypeScript ESM (`.js` imports for local files)
- pnpm workspaces (`pnpm@9.15.4`)
- Drizzle ORM on Postgres
- React 19 + Tailwind 4 for the web package
- The framework's `MemoryProvider` for contextual memory

## Where it fits

- **Depends on:** `@boringos/core`, `@boringos/agent`,
  `@boringos/module-sdk`, `@boringos/connector-google`,
  `@boringos/db`, `@boringos/shared`.
- **Provides capabilities:** `executive-source` (the dossier data
  surface), `executive-actions` (the affordance handlers).
- **Future consumers:** the Meetings Assistant (Week 4 of the master
  plan) will write prior-meeting summaries that EA reads for the
  "Recall + open items" section of the meeting drilldown. Until
  then those slots show "no prior meeting on file."

## Status

**All seven build phases shipped.** See
[`PHASE_PLAN.md`](./PHASE_PLAN.md) for what each phase delivered.

| Phase | Theme | State |
|---|---|---|
| 0 | Foundation — workspace + manifest + lifecycle stub | ✓ |
| 1a | Schema + read tools (8 tables, 5 tools) | ✓ |
| 1b | Persistence tools + meeting-thread anchoring | ✓ (refactor) |
| 2 | Morning composition — agent role + SKILL.md + 06:00 routine | ✓ |
| 3 | Dossier UI — PluginUI, Today + drilldowns + history | ✓ |
| 4 | Live deltas + conflict detection + 60s polling | ✓ |
| 5 | Feedback capture + reflection — `feedback_signals` + weekly routine | ✓ |
| 6 | Soak + polish — Settings page + OPERATIONS runbook | ✓ |

End-state numbers:
- **2 agent roles** (`executive-assistant`, `ea-travel-agent`)
- **2 SKILL.md** files shipped with the module
- **13 module-owned tables** prefixed `executive_assistant__`
- **4 migrations**, **26 tools** dispatched at `/api/tools/executive-assistant.*`
- **6 workflows + 4 routines** seeded per tenant on install
- **6 nav surfaces** in the BoringOS shell: Today, History, Memory & evidence, Meeting detail, Trip detail, Settings

The design is locked. See [`DESIGN.md`](./DESIGN.md) for schema,
decisions, and principles; [`OPERATIONS.md`](./OPERATIONS.md) for
the soak runbook; the two HTML files in [`docs/`](./docs/) for the
visual companions.

## Quickstart (after Phase 0 lands)

```bash
pnpm install
pnpm typecheck
pnpm -r build
```

Then register the module on a BoringOS host:

```ts
import { createExecutiveAssistantModule } from "@executive-assistant/server";
app.module(createExecutiveAssistantModule);
```

`defaultInstall: false` — tenants opt in via the framework install
API. On install, lifecycle seeds the agent, workflows, and routines.

## License

TBD. The Personal AI Stack is private for David's use during Phase 1.
Licensing for any open-source release lands at end of Phase 1.
