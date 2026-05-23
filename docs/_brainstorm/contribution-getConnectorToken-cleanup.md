# Contribution plan — `getConnectorToken` cleanup (boringos)

**Repo:** `BoringDev/boringos`
**Type:** small, focused refactor
**Status:** planned; not started
**Captured during:** EA brainstorm on event-driven framework (paused to investigate framework architecture, found a design wart, made a decision)

## Why this PR

The `getConnectorToken` primitive landed on branch `refactor/google-oauth-token-access` (commit `8390b51`). It's the right idea — framework owns OAuth token brokerage so modules don't repeat refresh logic — but the implementation has one wart worth fixing before merge or as a follow-on PR.

```ts
// core/src/modules/google.ts
export async function getConnectorTokenForTenant(
  db: Db,
  kind: "google" | "slack",   // takes a kind…
  tenantId: string,
): Promise<{ accessToken: string } | null> {
  if (kind !== "google") return null;   // …but only handles one
  // ...Google-specific logic...
}
```

The function lives in `google.ts` (correct — Google logic belongs in the Google module) but its signature pretends to be a multi-provider dispatcher. Confusing contract; misleading when a contributor adds Slack and wonders why this function "supports" Slack but does nothing for it.

## The change

Three files. ~30 lines net.

### 1. `core/src/modules/google.ts`

Rename `getConnectorTokenForTenant` → `getGoogleToken`. Drop the `kind` param. Body unchanged.

```ts
export async function getGoogleToken(
  db: Db,
  tenantId: string,
): Promise<{ accessToken: string } | null> {
  const creds = await loadGoogleCreds(db, tenantId);
  if (!creds) return null;
  // …rest of body unchanged: expiry check, refresh, persist, return…
}
```

### 2. `core/src/connector-tokens.ts` (new file)

Small dispatcher that owns the routing logic. Stays trivial as new providers land.

```ts
import type { Db } from "@boringos/db";
import { getGoogleToken } from "./modules/google.js";
// import { getSlackToken } from "./modules/slack.js"; // when Slack lands

const providers: Record<string, (db: Db, tenantId: string) => Promise<{accessToken: string} | null>> = {
  google: getGoogleToken,
  // slack: getSlackToken,
};

export async function getConnectorTokenForTenant(
  db: Db,
  kind: string,
  tenantId: string,
): Promise<{ accessToken: string } | null> {
  const provider = providers[kind];
  if (!provider) return null;
  return provider(db, tenantId);
}
```

### 3. `core/src/boringos.ts`

Update the import to point at the new dispatcher file (was importing from `./modules/google.js` for `getConnectorTokenForTenant`). One-line change.

```diff
-import { getConnectorTokenForTenant } from "./modules/google.js";
+import { getConnectorTokenForTenant } from "./connector-tokens.js";
```

The injection into `factoryDeps` stays identical.

### 4. `core/src/index.ts`

Re-export `getConnectorTokenForTenant` from the new location so callers that import it directly from `@boringos/core` aren't broken. One-line move.

### 5. `tests/connector-token.test.ts`

Tests already import from `@boringos/core`. They pass unchanged. Add one new case: `getConnectorTokenForTenant(db, "unknown-provider", tenantId)` returns null.

## Decision log

| # | Decision | Alternatives considered | Why |
|---|---|---|---|
| 1 | Framework owns the primitive (not Module) | Module owns: each module queries `connectors` table + implements refresh | Framework-owned avoids reimplementation, keeps refresh-token inside trust boundary, decouples from storage schema |
| 2 | Option A — per-file providers + simple dispatcher | Option B — runtime registry that connector modules contribute to | A keeps framework small; built-ins fit; community providers would need a PR but that's acceptable for now |
| 3 | Dispatcher in `core/src/connector-tokens.ts` (new file) | Inline in `boringos.ts`; in `modules/google.ts` | Own file = single responsibility; cheap to grep for; trivial diff when adding a new provider |
| 4 | Drop `kind` from `getGoogleToken` signature | Keep `kind` for symmetry across providers | Honest signature; the dispatcher is what takes `kind` |
| 5 | Defer Option B (pluggable registry) | Build registry now | YAGNI — Option B is the right shape *when* community connectors arrive; today there are zero non-built-in connectors |

## Test plan

- Existing 9 unit tests in `tests/connector-token.test.ts` pass without modification.
- New test: dispatcher returns `null` for unknown kind.
- New test: dispatcher routes `kind="google"` to `getGoogleToken` (mock and verify).
- Manual: `scripts/test-connector-token.ts` still works against a real Google connection.

## Out of scope (explicit non-goals)

- ❌ Adding Slack to the dispatcher. Slack provider lands when someone needs it.
- ❌ Pluggable runtime registry (Option B). YAGNI until a community connector lands.
- ❌ Renaming the `connectors` table or changing token storage shape.
- ❌ Bigger event-driven / webhook framework. That's a separate brainstorm.

## Open questions when cutting the PR

- Does the boringos maintainer want this refactor *bundled with* the original `refactor/google-oauth-token-access` PR (clean history) or as a follow-on (atomic reverts)?
- Is there a convention for where small core-internal files like `connector-tokens.ts` live? (Sibling of `modules/`, sibling of `oauth.ts`, or inside `modules/`?)

## Reference artifacts

- `docs/_brainstorm/google-oauth-token-refactor.html` — explainer of the original change.
- `docs/_brainstorm/boringos-primitives.html` — framework architecture explainer (Modules / Plugins / Connectors).
