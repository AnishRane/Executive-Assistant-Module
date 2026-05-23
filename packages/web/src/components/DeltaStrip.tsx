// Inline strip rendered on a meeting/trip drilldown when a delta has
// landed. Mirrors the "delta-strip" styling in View 2 of the mockup.

import type { Delta } from "../hooks/useDossier.js";
import { formatTime } from "../lib/format.js";

const variantClass: Record<string, string> = {
  rescheduled: "bg-[var(--color-amber-soft)] border-[var(--color-accent)]",
  flight_delayed: "bg-[var(--color-amber-soft)] border-[var(--color-accent)]",
  trip_leg_updated: "bg-[var(--color-amber-soft)] border-[var(--color-accent)]",
  meeting_updated: "bg-[var(--color-paper-warm)] border-[var(--color-accent)]",
  ooo_updated: "bg-[var(--color-paper-warm)] border-[var(--color-accent)]",
  cascading_impact: "bg-[var(--color-red-soft)] border-[var(--color-conflict)]",
};

export function DeltaStrip({ delta }: { delta: Delta }) {
  const cls = variantClass[delta.deltaKind] ?? "bg-[var(--color-paper-warm)] border-[var(--color-accent)]";
  return (
    <div
      className={`flex items-center gap-3.5 border-l-[3px] rounded-r-md px-4 py-2.5 mb-2 ${cls}`}
    >
      <div className="flex-1 text-sm text-[var(--color-ink)]">
        {delta.summary ?? "Something changed since the morning snapshot."}
      </div>
      <div className="font-mono text-[11px] text-[var(--color-muted)]">
        {formatTime(new Date(delta.occurredAt))}
      </div>
    </div>
  );
}
