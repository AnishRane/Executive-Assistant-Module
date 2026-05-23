// Page header — eyebrow date + a single h1. Shell-native typography
// (Inter, 24 px h1 not 32; section label not font-mono). The narrative
// paragraph is no longer rendered here — moved to DayBriefCard in
// Phase B. For Phase A this header just labels the day.

import { formatDateLong } from "../lib/format.js";
import type { Snapshot } from "../hooks/useDossier.js";

export function DayHeader({
  snapshot,
  fallbackDate,
}: {
  snapshot: Snapshot | null | undefined;
  /** Used when no snapshot exists yet (e.g. before the morning compose runs). */
  fallbackDate: string;
}) {
  const date = snapshot?.snapshotDate ?? fallbackDate;
  const generated = snapshot?.generatedAt;

  return (
    <header className="mb-6">
      <div className="text-[11px] font-semibold tracking-[0.06em] uppercase text-[var(--color-muted)] mb-1.5">
        {formatDateLong(date)}
        {generated && (
          <span className="font-normal normal-case tracking-normal text-[12px] ml-2 lowercase">
            · composed {new Date(generated).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
          </span>
        )}
      </div>
      <h1 className="text-2xl font-semibold leading-tight tracking-[-0.005em] text-[var(--color-ink)]">
        {snapshot ? "Today" : "No dossier composed yet"}
      </h1>
    </header>
  );
}
