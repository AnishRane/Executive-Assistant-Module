// Loading-state primitive — visually distinct from EmptyState.
//
// Three pulsing skeleton bars + a quiet label. The user's eye reads
// the geometry as "shape coming" — different from EmptyState's
// "intentionally nothing here" signal. Centered for use inside a
// section body; compact variant for use inside a card/drawer.
//
// Design rule (from CRM audit): loading and empty are never the
// same visual. If you want a one-liner loading indicator, use this
// component, not EmptyState with the text "Loading…".

export interface LoadingStateProps {
  /** Optional caption below the skeleton. Defaults to none. */
  label?: string;
  /** Compact variant for in-card or in-drawer use. */
  compact?: boolean;
}

export function LoadingState({ label, compact = false }: LoadingStateProps) {
  return (
    <div
      className={`flex flex-col items-center justify-center text-center ${
        compact ? "py-6" : "py-12"
      }`}
      aria-busy="true"
      aria-live="polite"
    >
      <div className="flex flex-col items-stretch gap-2 w-[180px]">
        <div className="h-2 rounded-full bg-[var(--color-rule)] animate-pulse" />
        <div
          className="h-2 rounded-full bg-[var(--color-rule)] animate-pulse"
          style={{ animationDelay: "120ms" }}
        />
        <div
          className="h-2 rounded-full bg-[var(--color-rule)] animate-pulse w-2/3 self-center"
          style={{ animationDelay: "240ms" }}
        />
      </div>
      {label && (
        <div className="mt-3 text-[12px] text-[var(--color-muted)]">{label}</div>
      )}
    </div>
  );
}
