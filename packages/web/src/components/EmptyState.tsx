// Empty-state primitive — matches CRM's pattern verbatim.
//
// Always centered. Always carries the ∅ glyph (the visual cue that
// reads "intentionally empty, not loading"). Title is required;
// description is optional secondary copy; action is an optional CTA
// button that fires onClick.
//
// Use this for genuine "no data yet" surfaces. For loading, use the
// LoadingState component instead — the two visuals must never blur.

export interface EmptyStateProps {
  /** One-line primary message. Required. */
  title: string;
  /** Optional secondary line, explaining why or what to do. */
  description?: string;
  /** Optional CTA. When provided, renders a primary button below. */
  action?: { label: string; onClick: () => void };
  /** Override the default ∅ glyph. Use sparingly. */
  glyph?: string;
  /** Compact variant — smaller padding for use inside a card section. */
  compact?: boolean;
}

export function EmptyState({
  title,
  description,
  action,
  glyph = "∅",
  compact = false,
}: EmptyStateProps) {
  return (
    <div
      className={`flex flex-col items-center justify-center text-center ${
        compact ? "py-8" : "py-16"
      }`}
    >
      <div
        className={`mb-3 text-[var(--color-muted)] ${
          compact ? "text-[28px]" : "text-[40px]"
        } leading-none`}
        aria-hidden="true"
      >
        {glyph}
      </div>
      <h3 className="m-0 text-sm font-medium text-[var(--color-ink)]">
        {title}
      </h3>
      {description && (
        <p className="mt-1.5 text-sm text-[var(--color-muted)] max-w-[360px] leading-[1.55]">
          {description}
        </p>
      )}
      {action && (
        <button
          type="button"
          onClick={action.onClick}
          className="mt-4 bg-[var(--color-accent)] text-white border border-[var(--color-accent)] text-[13px] font-medium rounded-md px-4 py-1.5 hover:bg-[#a04a08] transition-colors cursor-pointer"
        >
          {action.label}
        </button>
      )}
    </div>
  );
}
