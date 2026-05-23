// SPDX-License-Identifier: UNLICENSED
//
// @executive-assistant/server — public surface.
//
// Hosts register the EA module via:
//
//   import { createExecutiveAssistantModule } from "@executive-assistant/server";
//   app.module(createExecutiveAssistantModule);
//
// defaultInstall: false — tenants opt in via the framework install
// API. On install: schema migrations create the executive_assistant__*
// tables, then lifecycle.onInstall runs (no-op in Phase 1a).

export { createExecutiveAssistantModule } from "./module.js";

// Re-export Drizzle schema for hosts that want to query EA tables
// directly (read-only views, integrations, custom routes).
export * from "./schema/index.js";
