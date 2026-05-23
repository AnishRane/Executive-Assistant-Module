// SPDX-License-Identifier: UNLICENSED
//
// `executive-assistant` Module — entry point.
//
// Hybrid module: owns its own schema (executive_assistant__* tables),
// exposes read/write tools at /api/tools/executive-assistant.<group>.<verb>,
// seeds two agents (executive-assistant + ea-travel-agent), five
// routines, and a clutch of workflows on install.
//
// defaultInstall: false — tenants opt in via the framework install
// API.

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import type {
  Module,
  ModuleFactory,
  Skill,
  SkillApplicabilityEvent,
} from "@boringos/module-sdk";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { ToolRegistry } from "@boringos/agent";

import { createExecutiveAssistantLifecycle } from "./lifecycle.js";
import { executiveAssistantMigrations } from "./migrations.js";
import { createExecutiveAssistantTools } from "./tools/index.js";
import type { EaDeps, EaEventBus, EaRealtimeBus } from "./tools/deps.js";

const __moduleDir = dirname(fileURLToPath(import.meta.url));

// v0.4.39 — task originKinds that wake the executive-assistant agent.
// v0.4.54 — split into two specialized roles. Each role has a tight
// scope per run, mirroring the proven hebbs-crm + Triage + Replier
// pattern where each agent run handles ONE atomic unit of work and
// stays under haiku's per-run tool-budget threshold.

// ea-day-composer handles the day-level composition: narrative,
// snapshot, timeline. ~6 tools per run.
const DAY_COMPOSER_TASK_ORIGIN_KINDS = new Set<string>([
  "agent-morning-compose",
  "agent-compose-refresh",
]);

// ea-meeting-briefer handles ONE meeting's prep brief per task. ~5
// tools per run.
const MEETING_BRIEFER_TASK_ORIGIN_KINDS = new Set<string>([
  "agent-meeting-brief",
]);

// Legacy executive-assistant role — kept for backwards-compat with
// tenants installed before v0.4.54. New tenants get the split roles
// above; legacy tenants stay on this catch-all.
const EA_TASK_ORIGIN_KINDS = new Set<string>([
  "agent-morning-compose",
  "agent-compose-refresh",
  "agent-meeting-brief",
  "agent-classify-pending",
  "agent-weekly-reflection",
]);

const TRAVEL_TASK_ORIGIN_KINDS = new Set<string>([
  "agent-travel-agent",
]);

/**
 * Read a SKILL.md file and strip its YAML frontmatter so it can be
 * embedded as an inline Skill body. The framework's default loader
 * parses frontmatter into Skill metadata, but only supports
 * `roles:` for `appliesTo`. We need `taskOriginKind` gating too, so
 * we construct the Skill object manually in this module.
 */
function loadSkillBody(relPath: string): string {
  const raw = readFileSync(join(__moduleDir, relPath), "utf-8");
  const m = /^---\n[\s\S]*?\n---\n?([\s\S]*)$/.exec(raw);
  return (m ? m[1] : raw).trim();
}

export const createExecutiveAssistantModule: ModuleFactory = (factoryDeps) => {
  const db = factoryDeps.db as PostgresJsDatabase;
  const getEventBus = (): EaEventBus | null =>
    (factoryDeps.eventBus ?? null) as EaEventBus | null;
  // v0.4.39: `realtimeBus` and `getConnectorToken` are now first-class
  // typed fields on `ModuleFactoryDeps`. The earlier bracket-notation
  // cast was for forward-compat with older SDK versions that lacked
  // these fields. The SDK is current; read them directly.
  const getRealtimeBus = (): EaRealtimeBus | null =>
    (factoryDeps.realtimeBus ?? null) as EaRealtimeBus | null;
  const toolRegistry = (factoryDeps.toolRegistry ?? null) as ToolRegistry | null;
  const getConnectorToken = factoryDeps.getConnectorToken ?? null;

  const deps: EaDeps = { db, getEventBus, getRealtimeBus, toolRegistry, getConnectorToken };

  // v0.4.39 — inline Skill objects with explicit `appliesTo`. The
  // role check (`agentRole === "<role>"`) is the primary guard;
  // `taskOriginKind` adds defense-in-depth so the 296-line SKILL.md
  // doesn't cross-inject if a future agent in the tenant ends up
  // with the same role string by accident (see boringos inbox-pipeline
  // token-burn fix for the original lesson).
  const eaSkill: Skill = {
    id: "executive-assistant.executive-assistant",
    source: "module",
    body: loadSkillBody("skills/executive-assistant/SKILL.md"),
    priority: 60,
    appliesTo: (e: SkillApplicabilityEvent) =>
      e.agentRole === "executive-assistant" &&
      EA_TASK_ORIGIN_KINDS.has(e.taskOriginKind ?? ""),
  };

  const travelSkill: Skill = {
    id: "executive-assistant.ea-travel-agent",
    source: "module",
    body: loadSkillBody("skills/ea-travel-agent/SKILL.md"),
    priority: 50,
    appliesTo: (e: SkillApplicabilityEvent) =>
      e.agentRole === "ea-travel-agent" &&
      TRAVEL_TASK_ORIGIN_KINDS.has(e.taskOriginKind ?? ""),
  };

  // v0.4.54 — new split agents.
  const dayComposerSkill: Skill = {
    id: "executive-assistant.ea-day-composer",
    source: "module",
    body: loadSkillBody("skills/ea-day-composer/SKILL.md"),
    priority: 60,
    appliesTo: (e: SkillApplicabilityEvent) =>
      e.agentRole === "ea-day-composer" &&
      DAY_COMPOSER_TASK_ORIGIN_KINDS.has(e.taskOriginKind ?? ""),
  };

  const meetingBrieferSkill: Skill = {
    id: "executive-assistant.ea-meeting-briefer",
    source: "module",
    body: loadSkillBody("skills/ea-meeting-briefer/SKILL.md"),
    priority: 60,
    appliesTo: (e: SkillApplicabilityEvent) =>
      e.agentRole === "ea-meeting-briefer" &&
      MEETING_BRIEFER_TASK_ORIGIN_KINDS.has(e.taskOriginKind ?? ""),
  };

  const module: Module = {
    id: "executive-assistant",
    name: "Executive Assistant",
    version: "0.1.2",
    description:
      "A daily dossier composed from calendar and email. Watches for travel, meetings, and the context that surrounds them.",
    defaultInstall: false,
    provides: ["executive-source", "executive-actions"],
    dependsOn: [],
    schema: executiveAssistantMigrations,
    tools: createExecutiveAssistantTools(deps),
    skills: [eaSkill, travelSkill, dayComposerSkill, meetingBrieferSkill],
    lifecycle: createExecutiveAssistantLifecycle(factoryDeps),
    __moduleDir,
  };

  return module;
};

// Default export so the host's install pipeline can resolve the
// factory. Its resolver tries `default` first, then a conventional
// `create${Id}Module` name — but "executive-assistant" produces a
// hyphen-containing identifier that isn't valid JS, so `default` is
// the only reliable path.
export default createExecutiveAssistantModule;
