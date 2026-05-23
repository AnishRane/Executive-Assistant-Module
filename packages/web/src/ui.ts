// SPDX-License-Identifier: UNLICENSED
//
// EA PluginUI export — what the BoringOS shell consumes after the
// module is installed on a tenant.
//
// Four route contributions:
//   /executive               Today's dossier (timeline + week strip)
//   /executive/memory        Memory & evidence
//   /executive/meetings/:id  Meeting drilldown (hidden — linked from cards)
//   /executive/trips/:id     Trip drilldown (hidden — linked from cards)
//
// Each route element is wrapped in an ErrorBoundary so a render
// error inside one screen doesn't blank the entire EA surface in
// the host shell. Failure stays scoped to the affected route.
//
// Side-effect import of the EA stylesheet — Vite library mode only
// emits a CSS asset if something in the entry graph imports CSS.

import "./index.css";

import { createElement, type ComponentType, type FC } from "react";
import type { PluginUI } from "@boringos/ui";

import { Today } from "./slots/Today.js";
import { MeetingDetail } from "./slots/MeetingDetail.js";
import { TripDetail } from "./slots/TripDetail.js";
import { MemoryEvidence } from "./slots/MemoryEvidence.js";
import { Settings } from "./slots/Settings.js";
import { ErrorBoundary } from "./components/ErrorBoundary.js";

/**
 * Wrap a slot component so render errors inside it surface as the
 * EA ErrorBoundary fallback instead of blanking the entire shell
 * surface. createElement instead of JSX so this file stays plain .ts
 * (the vite library-mode entry expects ui.ts).
 */
function withBoundary<P extends object>(
  Inner: ComponentType<P>,
): ComponentType<P> {
  const Wrapped: FC<P> = (props) =>
    createElement(ErrorBoundary, null, createElement(Inner, props));
  Wrapped.displayName = `EA(${Inner.displayName ?? Inner.name ?? "Slot"})`;
  return Wrapped;
}

export const executiveAssistantUI: PluginUI = {
  moduleId: "executive-assistant",
  displayName: "Executive Assistant",
  navItems: [
    { id: "today", label: "The Assistant", path: "/executive", element: withBoundary(Today), order: 10 },
    { id: "memory", label: "Memory", path: "/executive/memory", element: withBoundary(MemoryEvidence), order: 20 },
    // Hidden detail routes — linked from cards on the timeline.
    { id: "meeting-detail", label: "Meeting", path: "/executive/meetings/:id", element: withBoundary(MeetingDetail), hidden: true },
    { id: "trip-detail", label: "Trip", path: "/executive/trips/:id", element: withBoundary(TripDetail), hidden: true },
  ],
  entityPanels: [],
  entityActions: [],
  settingsPanels: [
    { id: "executive-assistant.settings", label: "Executive Assistant", element: withBoundary(Settings) },
  ],
};

export default executiveAssistantUI;
