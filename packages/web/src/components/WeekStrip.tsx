// Week strip — 7 day-tiles, Mon→Sun, sitting above the day body.
//
// Selected day = the one whose Now/Next/Later is currently rendered
// below. Today is visually distinct (amber ring + tint) even when
// it's not the selected day, so David always sees "where today is"
// relative to whichever day he's previewing.
//
// Each tile shows:
//   - weekday + day-of-month (mono)
//   - meeting count (or empty-day note)
//   - lead item title (most-notable meeting / trip / OOO)
//   - markers row (✈ travel · OOO · ⚠ conflict)

import type { DayTile } from "../hooks/useDossier.js";

interface WeekStripProps {
  tiles: DayTile[] | undefined;
  selectedDate: string;
  onSelectDate: (date: string) => void;
}

export function WeekStrip({ tiles, selectedDate, onSelectDate }: WeekStripProps) {
  if (!tiles) {
    // Loading placeholder — 7 dim tiles matching the final layout
    return (
      <div className="grid grid-cols-7 gap-2 mb-6">
        {Array.from({ length: 7 }).map((_, i) => (
          <div
            key={i}
            className="bg-[var(--color-surface)] border border-[var(--color-rule)] rounded-[10px] px-3 py-2.5 min-h-[92px]"
          />
        ))}
      </div>
    );
  }

  return (
    <div className="grid grid-cols-7 gap-2 mb-6">
      {tiles.map((tile) => {
        const isSelected = tile.date === selectedDate;
        return (
          <button
            key={tile.date}
            type="button"
            onClick={() => onSelectDate(tile.date)}
            className={[
              "text-left bg-[var(--color-surface)] border rounded-[10px] px-3 py-2.5 min-h-[92px] flex flex-col gap-1.5 transition-colors cursor-pointer",
              tile.isToday
                ? "border-[var(--color-accent)]"
                : "border-[var(--color-rule)] hover:bg-[var(--color-paper-warm)]",
              isSelected && !tile.isToday ? "bg-[var(--color-paper-warm)]" : "",
              tile.isToday ? "shadow-[0_0_0_2px_var(--color-accent-tint)]" : "",
            ].join(" ")}
          >
            <div className="flex items-baseline justify-between">
              <span className="text-[11px] font-semibold tracking-[0.04em] uppercase text-[var(--color-muted)]">
                {tile.weekday}
              </span>
              <span className="font-mono text-[13px] font-medium text-[var(--color-ink)]">
                {tile.dayOfMonth}
              </span>
            </div>

            <div className="text-[12px] text-[var(--color-ink)]">
              {tile.meetingCount > 0
                ? `${tile.meetingCount} meeting${tile.meetingCount === 1 ? "" : "s"}`
                : tile.hasOoo
                  ? "Out of office"
                  : tile.hasTravel
                    ? "Travel day"
                    : "No meetings"}
            </div>

            {tile.leadItemTitle && (
              <div className="text-[12px] text-[var(--color-muted-strong)] leading-tight line-clamp-2">
                {tile.leadItemTitle}
              </div>
            )}

            <div className="flex gap-1 mt-auto flex-wrap">
              {tile.hasTravel && <Marker tone="travel" label="✈ Travel" />}
              {tile.hasOoo && <Marker tone="ooo" label="OOO" />}
              {tile.hasConflict && <Marker tone="conflict" label="⚠ Conflict" />}
            </div>
          </button>
        );
      })}
    </div>
  );
}

function Marker({
  tone,
  label,
}: {
  tone: "travel" | "ooo" | "conflict";
  label: string;
}) {
  const cls =
    tone === "travel"
      ? "bg-[var(--color-paper-warm)] text-[var(--color-accent)]"
      : tone === "ooo"
        ? "bg-[var(--color-green-soft)] text-[var(--color-green)]"
        : "bg-[var(--color-red-soft)] text-[var(--color-conflict)]";
  return (
    <span
      className={`text-[9.5px] font-semibold tracking-[0.05em] uppercase px-1 py-[1px] rounded-[3px] ${cls}`}
    >
      {label}
    </span>
  );
}
