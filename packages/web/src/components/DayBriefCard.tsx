// DayBriefCard — the agent's narrative paragraph in its own card.
//
// CRM-style rule applied here: the section frame ALWAYS renders, so
// the page structure stays stable across all data conditions. When
// the brief is null (every morning before the compose agent has fired,
// every first install, every pre-OAuth state), the card renders an
// empty variant instead of silently disappearing.

import { BriefMarkdown } from "./BriefMarkdown.js";

const COMPOSE_PHASES = [
  "Reading your calendar",
  "Weighing the signals",
  "Writing your brief",
];

interface DayBriefCardProps {
  /** The narrative_brief string from the day's snapshot. Null = empty variant. */
  brief: string | null | undefined;
  /** Optional "composed at" timestamp to subtly date the brief. */
  composedAt?: string | null;
  /** When true, show animated skeleton while the agent is composing. */
  generating?: boolean;
  /** Index into COMPOSE_PHASES for the cycling status label. */
  generatingPhase?: number;
  /** When true, skeleton timed out — show retry prompt instead. */
  timedOut?: boolean;
  /** Called when the user clicks "Refresh brief". */
  onRetry?: () => void;
}

export function DayBriefCard({
  brief,
  composedAt,
  generating = false,
  generatingPhase = 0,
  timedOut = false,
  onRetry,
}: DayBriefCardProps) {
  const stamp = composedAt
    ? new Date(composedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : null;

  return (
    <div className="bg-[var(--color-surface)] border border-[var(--color-rule)] rounded-[12px] px-[22px] py-[18px] mb-4">
      <div className="flex items-baseline justify-between mb-1.5">
        <span className="text-[11px] font-semibold tracking-[0.06em] uppercase text-[var(--color-muted)]">
          Day brief · agent's read
        </span>
        {brief && stamp && !generating && (
          <span className="font-mono text-[11px] text-[var(--color-muted)]">
            {stamp}
          </span>
        )}
      </div>

      {brief ? (
        // v0.4.22: brief takes precedence over `timedOut`. If a brief
        // exists, it's the source of truth — render it; the user can
        // still hit Refresh below.
        // v0.4.49: agent narratives use markdown (## headings, **bold**
        // ranges, lists). Render via BriefMarkdown so the structure
        // is visible instead of leaking the raw syntax.
        <>
          <BriefMarkdown body={brief} />
          {onRetry && (
            <button
              type="button"
              onClick={onRetry}
              className="text-[11px] font-medium text-[var(--color-accent)] hover:underline cursor-pointer mt-3"
              title="Have the agent re-read today's signal and rewrite the brief"
            >
              Refresh →
            </button>
          )}
        </>
      ) : timedOut ? (
        <div>
          <p className="text-[14px] text-[var(--color-muted)] italic m-0 mb-3">
            Taking longer than usual.
          </p>
          {onRetry && (
            <button
              type="button"
              onClick={onRetry}
              className="text-[13px] font-medium text-[var(--color-accent)] hover:underline cursor-pointer"
            >
              Refresh brief →
            </button>
          )}
        </div>
      ) : generating ? (
        <div>
          <div className="space-y-2.5 animate-pulse mb-5">
            <div className="h-2.5 rounded-full bg-[var(--color-rule)] w-full" />
            <div className="h-2.5 rounded-full bg-[var(--color-rule)] w-[94%]" />
            <div className="h-2.5 rounded-full bg-[var(--color-rule)] w-[88%]" />
            <div className="h-2.5 rounded-full bg-[var(--color-rule)] w-[96%]" />
            <div className="h-2.5 rounded-full bg-[var(--color-rule)] w-[79%]" />
            <div className="h-2.5 rounded-full bg-[var(--color-rule)] w-[91%]" />
          </div>
          <div className="flex items-center gap-2">
            <SpinnerIcon />
            <span
              key={generatingPhase}
              className="text-[11px] text-[var(--color-muted)] transition-opacity duration-300"
            >
              {COMPOSE_PHASES[generatingPhase % COMPOSE_PHASES.length]}…
            </span>
          </div>
        </div>
      ) : (
        <p className="text-[14px] leading-[1.55] text-[var(--color-muted)] italic m-0">
          The agent's read on today appears here after the next compose tick. Until then, the structured signals below tell the day's shape.
        </p>
      )}
    </div>
  );
}

function SpinnerIcon() {
  return (
    <svg
      className="animate-spin h-3 w-3 shrink-0 text-[var(--color-accent)]"
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
    >
      <circle
        className="opacity-25"
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeWidth="4"
      />
      <path
        className="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
      />
    </svg>
  );
}
