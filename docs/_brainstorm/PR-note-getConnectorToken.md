# feat(google, slack): add `getConnectorToken` with audited dispatcher

## Summary

Adds `ModuleFactoryDeps.getConnectorToken(kind, tenantId, callerModuleId)` a typed primitive that lets any module request a fresh OAuth access token for a connected provider without going through the tool registry. Implements proactive Google token refresh, automatic credential persistence, and a per-call audit log. Ships with **Google** + **Slack** providers registered out of the box; adding a new one is a single map entry.

## What this PR does

- **New primitive:** modules call `deps.getConnectorToken("google", tenantId, "my-module")` and get back `{ accessToken } | null`. Direct provider API calls become trivial no wrapper tool needed.
- **Per-file dispatcher design:** each provider keeps its own load + refresh logic in its module file (`getGoogleToken` in `modules/google.ts`, `getSlackToken` in `modules/slack.ts`); a small dispatcher in `connector-tokens.ts` routes by `kind`. Adding a new provider is one entry in the providers map.
- **Proactive Google refresh:** if `expiresAt < now + 60s`, dispatcher calls `refreshOAuthToken`, persists the new token to `connectors`, returns the refreshed value. Falls back to existing token on refresh failure.
- **Audit log:** new `connector_token_issuance` table records every call (`tenant_id`, `kind`, `caller_module_id`, `outcome`, `issued_at`). Token itself is **never** persisted. Writes are fire-and-forget  logging failures can't block issuance. Two indexes for the common queries: by-kind and by-caller.

## Why it matters

| Concern | Before | With this PR |
|---|---|---|
| Refresh logic | Every module reimplements it | Single audited implementation |
| Schema coupling | Modules import `connectors` table from `@boringos/db` | Stable `getConnectorToken` interface |
| Trust boundary | Refresh tokens leak into module address space | Stay in framework; modules see access tokens only |
| Auditability | Direct-fetch path writes nothing | Every issuance writes `connector_token_issuance` |
| New providers | Fork core to wrap new endpoints | Call any provider API directly from any module |
| New connectors | PR to core for each | Register in dispatcher map; ~10 lines |

## Tests

- **15 unit tests** in `tests/connector-token.test.ts`  dispatcher routing (Google, Slack, unknown), refresh paths (fresh, expiring + refresh, refresh-fails fallback, no refresh-token, persistence), audit row content, default `callerModuleId`, audit-write failure isolation.
- **`pnpm -r typecheck`** clean across the monorepo.
- **`pnpm -r build`** clean.
- **Manual:** `npx tsx scripts/test-connector-token.ts` boots embedded Postgres, exercises all three Google paths, then queries `connector_token_issuance` and verifies the audit rows landed with the expected `caller_module_id` and outcomes.

## Migration / compatibility

- **DB:** bootstrap migration creates `connector_token_issuance` if missing. Safe against existing databases  no data migration.
- **Existing modules:** unaffected. `getConnectorToken` is a new optional field on `ModuleFactoryDeps`.
- **New callers:** pass your own manifest id as the third argument so audit rows attribute correctly:
  ```ts
  await deps.getConnectorToken("google", ctx.tenantId, "your-module-id")
  ```
- **`kind` is now `string`**, not the old `"google" | "slack"` union  supports new providers without an SDK bump.

## Known follow-ons (out of scope here)

1. **Provider throws aren't audited.** If `getGoogleToken` throws mid-refresh, the dispatcher re-throws without writing an audit row. Adding an `"error"` outcome closes the gap.
2. **Third-party connector providers** still require a PR to core's dispatcher map. A runtime registry pattern lands when an actual third-party connector module ships.
3. **Multi-account:** current `loadGoogleCreds` does `LIMIT 1`. Multi-account would extend the signature with an optional `accountId`.
