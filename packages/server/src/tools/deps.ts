// Shared dependencies threaded into every tool factory in
// packages/server/src/tools/*.ts. Built once in module.ts from the
// ModuleFactoryDeps the framework injects, then handed to each tool
// factory as a closure capture.
//
// Mirrors the pattern in hebbs-crm — keep the shape stable so the
// per-entity tool files can be refactored without touching the
// factory wiring.

import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { ToolRegistry } from "@boringos/agent";

/**
 * Internal connector event bus (in-process). Other modules subscribe;
 * browsers never see it. Kept for any cross-module wiring; not the
 * path SSE clients consume.
 */
export interface EaEventBus {
  emit(event: {
    connectorKind: string;
    type: string;
    tenantId: string;
    data: Record<string, unknown>;
    timestamp: Date;
  }): Promise<void> | void;
}

/**
 * Realtime bus (v0.4.20). Whatever we publish here flows out through
 * the framework's GET /api/events SSE endpoint to any authenticated
 * subscriber on the same tenant. UI integration is blocked on a
 * framework session-auth change for /api/events; server-side publish
 * is shipped so consumers are ready the moment that lands.
 *
 * Shape matches @boringos/core/src/realtime.ts → RealtimeBus.publish:
 *   { type, tenantId, data, timestamp } — timestamp is an ISO string.
 */
export interface EaRealtimeBus {
  publish(event: {
    type: string;
    tenantId: string;
    data: Record<string, unknown>;
    timestamp: string;
  }): void;
}

export interface EaDeps {
  db: PostgresJsDatabase;
  /** Internal event bus (cross-module). Read at call time — undefined-safe. */
  getEventBus: () => EaEventBus | null;
  /** Realtime / SSE bus. Read at call time — undefined-safe. */
  getRealtimeBus: () => EaRealtimeBus | null;
  /**
   * The framework's tool registry. Still needed for internal
   * cross-tool dispatches (e.g. meetings.upsert_from_calendar).
   */
  toolRegistry: ToolRegistry | null;
  /**
   * Returns a valid, auto-refreshed OAuth access token for a
   * connected provider. Null when the host predates
   * refactor/google-oauth-token-access or the tenant hasn't
   * connected the provider yet.
   *
   * v0.4.33: signature now includes `callerModuleId` (self-reported
   * module id, used for audit attribution in `connector_token_issuance`)
   * and widens `kind` to `string` to match the framework dispatcher
   * shape.
   */
  getConnectorToken: ((kind: string, tenantId: string, callerModuleId: string) => Promise<{ accessToken: string } | null>) | null;
}

export function emitEa(
  deps: EaDeps,
  type: string,
  tenantId: string,
  data: Record<string, unknown>,
): void {
  const bus = deps.getEventBus();
  if (!bus) return;
  // Fire-and-forget — tool callers shouldn't block on subscriber failures.
  void Promise.resolve(
    bus.emit({
      connectorKind: "executive-assistant",
      type,
      tenantId,
      data,
      timestamp: new Date(),
    }),
  ).catch(() => {});
}

/**
 * Publish on the realtime bus. All EA event types are namespaced
 * `executive-assistant:<thing>.<action>` so subscribers can filter.
 * Fire-and-forget; bus failures don't propagate.
 */
export function publishRealtime(
  deps: EaDeps,
  type: string,
  tenantId: string,
  data: Record<string, unknown>,
): void {
  const bus = deps.getRealtimeBus();
  if (!bus) return;
  try {
    bus.publish({
      type,
      tenantId,
      data,
      timestamp: new Date().toISOString(),
    });
  } catch {
    // Realtime publish must never break the parent write.
  }
}
