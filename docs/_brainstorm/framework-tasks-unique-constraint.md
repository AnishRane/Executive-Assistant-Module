# Framework PR — DB-level dedup for `(origin_kind, origin_id, tenant_id)` on tasks

> Companion to EA v0.4.41 Fix A. Closes the sub-millisecond race that
> the module-side pre-check cannot.

## Problem

Multiple callers can fire `framework.tasks.create` with identical
`(origin_kind, origin_id, tenant_id)` in rapid succession. We measured
this happening in EA install windows:

| Trigger | Source |
|---|---|
| `onInstall` hook | EA `lifecycle.ts:199-209` |
| UI mount | EA `Today.tsx:133` |
| 15-min compose cron's first tick | EA `lifecycle.ts:738-742` |
| `connector.connected` workflow | EA workflow seed |
| 1-min calendar sync cron | EA `lifecycle.ts:720-725` |

All can fire within seconds of install. Until the agent finishes its
first run and writes a snapshot, every caller's hash-guard sees
`priorHash = null` and falls through to `tasks.create` with the same
`origin_id`.

The framework's `tasks.create` handler today is a plain INSERT, no
ON CONFLICT, no unique constraint:

```ts
// packages/@boringos/core/src/modules/framework.ts:359-374
await db.insert(tasks).values({
  id, tenantId, title, originKind,
  originId: input.originId,
  // ...
});
```

Result: N duplicate task rows for one user-visible piece of work.
Wakeup coalescing prevents N _concurrent_ agent runs, but framework
auto-rewake-on-success means the agent will be woken N times
sequentially as it works through each duplicate todo. **One brief
becomes N × ~90s of agent work.** We saw this in production: 3
duplicate compose tasks → 3 sequential agent runs → ~4.5 minutes of
work for one visible brief.

## Why module-side dedup isn't enough

EA v0.4.41 Fix A adds a pre-check inside `compose.maybe_create_task`:

```sql
SELECT id FROM tasks
WHERE tenant_id = ?
  AND origin_kind = ?
  AND origin_id = ?
  AND status IN ('todo', 'running')
  AND created_at > now() - interval '15 minutes'
LIMIT 1
```

If a match exists, return its id instead of creating a new task. This
catches the 99% case where triggers fire seconds apart. But two
callers can still race between the SELECT and the subsequent INSERT
in the framework. Without a DB constraint, both INSERTs succeed.

A framework-side constraint is the only real guarantee.

## Proposed change

### Schema migration

```sql
-- packages/@boringos/db/src/schema/tasks.ts or migrations/
CREATE UNIQUE INDEX IF NOT EXISTS tasks_dedup_origin_idx
  ON tasks (tenant_id, origin_kind, origin_id)
  WHERE origin_id IS NOT NULL;
```

`WHERE origin_id IS NOT NULL` keeps the index out of the way for
tasks that don't supply an originId (legacy / agent-created tasks
without dedup intent).

### Handler change

`packages/@boringos/core/src/modules/framework.ts` around line 359:

```ts
// Existing behavior: plain INSERT. Replace with ON CONFLICT DO NOTHING.
const result = await db.insert(tasks)
  .values({
    id, tenantId, title, /* ... */, originId: input.originId, /* ... */,
  })
  .onConflictDoNothing({
    target: [tasks.tenantId, tasks.originKind, tasks.originId],
  })
  .returning({ id: tasks.id });

// If conflict (no row returned), look up the existing task by the
// dedup key and return that id instead.
let existingId: string;
if (result.length > 0) {
  existingId = result[0].id;
} else {
  const existing = await db.select({ id: tasks.id })
    .from(tasks)
    .where(and(
      eq(tasks.tenantId, ctx.tenantId),
      eq(tasks.originKind, originKind),
      eq(tasks.originId, input.originId!),
    ))
    .limit(1);
  existingId = existing[0]!.id;
}

// Continue with engine.wake using existingId.
```

Callers that pass no `originId` get unchanged behavior (no dedup, no
conflict possible).

### Wake side-effect

When a conflict collapses to an existing task, should the framework
still call `engine.wake(...)` for that task? Yes — the existing task
might be in `todo` and not yet running. Waking is idempotent
(coalesces with any pending wake). So always wake after the upsert.

## Code touchpoints

| File | Change |
|---|---|
| `packages/@boringos/db/src/schema/tasks.ts` | Add the unique index (or in a new migration file if migrations are file-based) |
| `packages/@boringos/core/src/modules/framework.ts` | Replace `db.insert(tasks).values(...)` with conflict-aware upsert |
| `packages/@boringos/core/src/modules/framework.ts` tests | Add a test: two concurrent `tasks.create` calls with same `(originKind, originId, tenantId)` → only one row, both calls return same id |

Total: ~30 lines of code, one migration, one new test.

## Backwards compatibility

- Tasks created without `originId` (most agent-created tasks) skip the
  partial-unique-index → unaffected.
- Existing duplicate rows already in the DB are not touched by the
  migration (`CREATE UNIQUE INDEX` only enforces going forward). If
  there are existing duplicates, the index creation fails. A
  pre-migration cleanup step might be needed:

  ```sql
  -- Delete duplicates, keeping the oldest row per group.
  DELETE FROM tasks t USING tasks t2
  WHERE t.id > t2.id
    AND t.tenant_id = t2.tenant_id
    AND t.origin_kind = t2.origin_kind
    AND t.origin_id = t2.origin_id
    AND t.origin_id IS NOT NULL;
  ```

- All existing callers that pass `originId` get cleaner behavior (no
  duplicate rows). Callers that don't are unaffected.

## Versioning

Minor version bump on `@boringos/core` (handler behavior change is
strictly improving) and the DB migration step.

## Open question

Should the result return a `wasDeduplicated: boolean` field so callers
can distinguish "created" from "already existed"? Useful for telemetry
and for the EA Fix A code to know whether it just collapsed a race.
Not strictly required.

## Filing checklist

- [ ] Title: "feat(framework): DB-level dedup on tasks origin_kind+origin_id"
- [ ] Reference this doc + the EA v0.4.41 ship (Fix A as the consumer)
- [ ] Migration safety note: pre-existing duplicate rows must be
      cleaned before the unique index can be created
- [ ] Test pattern: two concurrent dispatcher calls with same originId
      → one row, both return same id
- [ ] Confirm no breaking change to public `framework.tasks.create`
      return shape (id stays the same; optional `wasDeduplicated`
      field is additive)
