# Framework PR — module-shipped persona bundles

> Companion to EA v0.4.41. EA ships SOUL.md / AGENTS.md / HEARTBEAT.md inside its
> module bundle. The framework needs to pick them up.

## Problem

`packages/@boringos/agent/src/persona-loader.ts` reads persona files from a fixed
filesystem path inside the framework package:

```ts
const PERSONAS_DIR = join(__dirname, "personas");
// ...
const dir = join(PERSONAS_DIR, resolved);
return {
  soul: await load("SOUL.md"),
  agents: await load("AGENTS.md"),
  heartbeat: await load("HEARTBEAT.md"),
};
```

Consequences:
- Roles must exist in the framework's `personas/` folder to get a real persona.
- Unknown roles fall back to `default/AGENTS.md` (10 lines).
- Third-party modules cannot ship their own persona without a framework PR.
- The `ALIASES` map (`ea` → `personal-assistant`) is the only escape valve, and
  it only redirects to other framework-side bundles, not to module-shipped ones.

EA today has roles `executive-assistant` and `ea-travel-agent`. Neither matches
a folder. Both fall back to the 10-line default. EA's 293-line SKILL.md is doing
100% of the work that should be split between persona and skill.

## What EA v0.4.41 will ship

Inside the EA module bundle:

```
packages/server/src/skills/executive-assistant/
  SKILL.md         # trimmed from 293 → ~80 lines
  SOUL.md          # NEW — character, voice, principles
  AGENTS.md        # NEW — territory + collaboration with other agents
  HEARTBEAT.md     # NEW — operating checklist per wake
```

`module.ts` already reads `SKILL.md` via `loadSkillBody()`. The three new files
sit dormant on disk until the framework knows to load them.

**Safe to ship as-is:** nothing in the framework or in `module.ts` references
the new files, so they're inert. No errors, no behavior change from their
presence alone.

## What the framework needs to change

Two viable options. Recommended: option A.

### Option A — Module-side persona lookup (recommended)

Extend the `Module` interface in `@boringos/module-sdk` with an optional
`personas` field, and teach `loadPersonaBundle` to look there first.

```ts
// module-sdk
interface Module {
  // ...existing fields...
  personas?: Record<string, PersonaBundle>;
}

// agent/persona-loader.ts
export async function loadPersonaBundle(
  role: string,
  registry?: ModuleRegistry,
): Promise<PersonaBundle> {
  // 1. Check module-shipped personas first
  if (registry) {
    for (const module of registry.modules) {
      if (module.personas?.[role]) return module.personas[role];
    }
  }
  // 2. Fall back to framework-side personas (existing behavior)
  const resolved = resolvePersonaRole(role);
  const dir = join(PERSONAS_DIR, resolved);
  return {
    soul: await load(dir, "SOUL.md"),
    agents: await load(dir, "AGENTS.md"),
    heartbeat: await load(dir, "HEARTBEAT.md"),
  };
}
```

Module factories construct their `personas` field once at boot:

```ts
// EA module.ts
const module: Module = {
  // ...
  skills: [eaSkill, travelSkill],
  personas: {
    "executive-assistant": {
      soul: loadFile("skills/executive-assistant/SOUL.md"),
      agents: loadFile("skills/executive-assistant/AGENTS.md"),
      heartbeat: loadFile("skills/executive-assistant/HEARTBEAT.md"),
    },
    "ea-travel-agent": {
      // shared persona for v0.4.41
      soul: loadFile("skills/executive-assistant/SOUL.md"),
      agents: loadFile("skills/executive-assistant/AGENTS.md"),
      heartbeat: loadFile("skills/executive-assistant/HEARTBEAT.md"),
    },
  },
};
```

**Pros:** modules are self-contained, no framework changes per third-party module.
**Cons:** adds SDK surface area; needs `ModuleRegistry` plumbed into the loader
caller (already exists, just needs to be passed through `providers/persona.ts`).

### Option B — Convention: framework auto-discovers a `personas/` folder inside `.hebbsmod`

Framework scans extracted module store at boot for `personas/<role>/SOUL.md`
shape. No SDK change. Heavier and more magical.

Not recommended.

## Code touchpoints (option A)

| File | Change |
|---|---|
| `packages/@boringos/module-sdk/src/types.ts` | Add `personas?: Record<string, PersonaBundle>` to `Module`. |
| `packages/@boringos/agent/src/persona-loader.ts` | `loadPersonaBundle` takes an optional `registry` arg, checks modules first. Export `PersonaBundle` from sdk to avoid duplication. |
| `packages/@boringos/agent/src/providers/persona.ts` | Pass the module registry through to `loadPersonaBundle`. |
| `packages/@boringos/agent/src/templates.ts` | Same. |
| Tests | Add a unit test: module ships persona, framework loads it. |

Total: ~50 lines of code, one new test, one SDK type addition.

## Backwards compatibility

- Existing framework-side personas keep working. The fallback chain becomes:
  module-side → framework-side `personas/<role>/` → ALIASES redirect → `default/`.
- Modules that don't ship personas are unaffected.
- The 14 existing framework persona folders need no changes.

## Versioning + migration

- SDK adds optional field → minor version bump on `@boringos/module-sdk`.
- Framework: minor version bump on `@boringos/agent`.
- EA needs to bump its pinned SDK version after the PR merges to start using the
  field. v0.4.42 of EA would be the first ship that uses module-side personas
  for real.

## Open question

Should we also remove the `ALIASES` map entry `ea: "personal-assistant"`?
Once EA ships its own `executive-assistant` persona via the module field, the
alias is redundant. Leaving it in costs nothing; removing it cleans up. Defer
to whoever reviews the framework PR.

## Filing checklist (for whoever opens the issue)

- [ ] Title: "feat(module-sdk, agent): module-shipped persona bundles"
- [ ] Reference this doc + the EA v0.4.41 PR
- [ ] Note that EA module already ships the files (dormant), so the PR has a
      real consumer to test against
- [ ] Suggest the unit test pattern above
- [ ] Confirm no breaking change in the public Module type (optional field only)
