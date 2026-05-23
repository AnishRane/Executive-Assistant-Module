// FocusCard — the Now and Next centerpieces of the day body.
//
// Visual structure:
//   ┌─────────────────────────────────────────────────────────┐
//   │ time gutter    │  KIND CHIP + label + inline badges     │
//   │ (70px)         │  TITLE                                 │
//   │                │  subline (kind-specific)               │
//   │                │  brief or kind-specific affordance     │
//   └─────────────────────────────────────────────────────────┘
//
// Variant:
//   - "now"  — amber ring + accent-tint shadow + amber label
//   - "next" — plain border + muted label
//
// v0.4.29 (Phase 2): the inner body switches on `kind`. Meeting/Event/
// Task each get a slightly different anatomy where it adds value
// (Meeting → Join button when conferenceLink present, Task → checkbox
// + duration pill). Trip and OOO retain prior behavior with a kind
// chip added.

import { Link } from "react-router-dom";
import { Badge } from "./Badge.js";
import { KindChip, kindLabel, type ItemKindUi } from "./KindChip.js";

const BRIEF_PHASES = [
  "Reading agenda",
  "Recalling context",
  "Drafting brief",
];

export interface FocusCardData {
  /** Stable id for the underlying entity (meeting / trip_leg / ooo). */
  refId: string;
  /** What kind it is — drives the chip, link target, anatomy. */
  kind: ItemKindUi;
  title: string;
  /** Short subline: attendees / location / etc. Hidden if empty. */
  sub?: string | null;
  /** Optional brief excerpt rendered as a paragraph below sub. */
  brief?: string | null;
  /** ISO timestamp. Used to compute the time gutter and "in N min" hint. */
  startsAt: string;
  /** ISO timestamp for the meeting/leg end. Optional. */
  endsAt?: string | null;
  /** Short timezone abbreviation, e.g. "IST" / "EDT". */
  tzAbbr?: string | null;
  /** Optional video link — drives Meeting's Join affordance. */
  conferenceLink?: string | null;
  /** v0.4.57: optional physical location string. Rendered with a pin
   * icon as a Google Maps link when present. */
  location?: string | null;
  /** Inline signal flags. */
  hasDelta?: boolean;
  deltaLabel?: string;
  hasConflict?: boolean;
  conflictLabel?: string;
}

interface FocusCardProps {
  variant: "now" | "next";
  data: FocusCardData;
  generatingBrief?: boolean;
  briefPhase?: number;
}

export function FocusCard({
  variant,
  data,
  generatingBrief = false,
  briefPhase = 0,
}: FocusCardProps) {
  const isNow = variant === "now";
  const startMs = new Date(data.startsAt).getTime();
  const nowMs = Date.now();
  const minsUntil = Math.round((startMs - nowMs) / 60_000);
  const when =
    minsUntil < 0
      ? "in progress"
      : minsUntil === 0
        ? "now"
        : minsUntil < 60
          ? `in ${minsUntil} min`
          : `in ${Math.round(minsUntil / 60)}h`;

  const time = new Date(data.startsAt).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const endTime = data.endsAt
    ? new Date(data.endsAt).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      })
    : null;

  const href =
    data.kind === "meeting" || data.kind === "event" || data.kind === "task" || data.kind === "untagged"
      ? `?meeting=${data.refId}`
      : data.kind === "trip_leg"
        ? `?trip=${data.refId}`
        : `/executive`;

  const wrapper = isNow
    ? "bg-[var(--color-surface)] border border-[var(--color-accent)] rounded-[12px] px-[22px] py-[18px] mb-3 shadow-[0_0_0_2px_var(--color-accent-tint)] block hover:bg-[var(--color-paper-warm)] transition-colors"
    : "bg-[var(--color-surface)] border border-[var(--color-rule)] rounded-[12px] px-[22px] py-[18px] mb-3 block hover:bg-[var(--color-paper-warm)] transition-colors";

  return (
    <Link to={href} className={wrapper}>
      <div className="grid grid-cols-[70px_1fr] gap-[18px] items-start">
        {/* Time gutter */}
        <div>
          <div className="font-mono text-[18px] font-medium leading-none text-[var(--color-ink)]">
            {time}
          </div>
          {endTime && (
            <div className="font-mono text-[13px] leading-none text-[var(--color-muted)] mt-1">
              – {endTime}
              {data.tzAbbr && (
                <span className="ml-1 text-[10.5px] tracking-[0.04em]">
                  {data.tzAbbr}
                </span>
              )}
            </div>
          )}
          <div
            className={`text-[11px] font-semibold tracking-[0.04em] uppercase mt-1.5 ${
              isNow ? "text-[var(--color-accent)]" : "text-[var(--color-muted)]"
            }`}
          >
            {isNow ? `Now · ${when}` : `Up next · ${when}`}
          </div>
        </div>

        {/* Body — kind-specific anatomy */}
        <div>
          <div className="flex items-baseline gap-2 flex-wrap mb-1.5">
            <KindChip kind={data.kind} />
            <span
              className={`text-[11px] font-semibold tracking-[0.06em] uppercase ${
                isNow
                  ? "text-[var(--color-accent)]"
                  : "text-[var(--color-muted)]"
              }`}
            >
              {kindLabel(data.kind)}
            </span>
            {data.hasDelta && (
              <Badge variant="changed">{data.deltaLabel ?? "Changed"}</Badge>
            )}
            {data.hasConflict && (
              <Badge variant="conflict">
                {data.conflictLabel ?? "Conflict"}
              </Badge>
            )}
          </div>

          <KindBody
            data={data}
            generatingBrief={generatingBrief}
            briefPhase={briefPhase}
          />
        </div>
      </div>
    </Link>
  );
}

// ─── kind-specific body content ───────────────────────────────────

interface KindBodyProps {
  data: FocusCardData;
  generatingBrief: boolean;
  briefPhase: number;
}

function KindBody({ data, generatingBrief, briefPhase }: KindBodyProps) {
  if (data.kind === "task") return <TaskBody data={data} />;
  return (
    <DefaultBody
      data={data}
      generatingBrief={generatingBrief}
      briefPhase={briefPhase}
    />
  );
}

function DefaultBody({ data, generatingBrief, briefPhase }: KindBodyProps) {
  // v0.4.40: drop the prior `<= 30 minutes` gate. If there's a video
  // link, surface it as soon as the card renders. People want to
  // copy/test/queue the link well before the meeting starts. The link
  // only exists on meeting-table-backed cards anyway (trip_leg / ooo
  // never have a conferenceLink), so no need to gate on `kind`.
  const showJoin = !!data.conferenceLink;
  return (
    <>
      <h3 className="text-[16px] font-medium leading-tight text-[var(--color-ink)] mb-1">
        {data.title}
      </h3>

      {data.sub && (
        <div className="text-[13px] text-[var(--color-muted)] mb-2">
          {data.sub}
        </div>
      )}

      {/* v0.4.57: location with pin icon, links to Google Maps. */}
      {data.location && (
        <a
          href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(data.location)}`}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
          className="inline-flex items-start gap-1.5 text-[12.5px] text-[var(--color-muted)] hover:text-[var(--color-accent)] hover:underline mb-2 leading-snug"
          title="Open in Google Maps"
        >
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            className="shrink-0 mt-[2px] text-[var(--color-accent)]"
          >
            <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" />
            <circle cx="12" cy="10" r="3" />
          </svg>
          <span className="truncate">{data.location}</span>
        </a>
      )}

      {showJoin && data.conferenceLink && (
        <a
          href={data.conferenceLink}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
          className="inline-flex items-center gap-1.5 text-[12px] font-medium text-[var(--color-accent)] hover:underline mb-2"
        >
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.2"
          >
            <path d="M23 7l-7 5 7 5V7z" />
            <rect x="1" y="5" width="15" height="14" rx="2" />
          </svg>
          Join video
        </a>
      )}

      {generatingBrief ? (
        <div className="mt-2">
          <div className="space-y-1.5 animate-pulse mb-2">
            <div className="h-2 rounded-full bg-[var(--color-rule)] w-full" />
            <div className="h-2 rounded-full bg-[var(--color-rule)] w-[88%]" />
            <div className="h-2 rounded-full bg-[var(--color-rule)] w-[75%]" />
          </div>
          <div className="flex items-center gap-1.5">
            <BriefSpinner />
            <span
              key={briefPhase}
              className="text-[11px] text-[var(--color-muted)] transition-opacity duration-300"
            >
              {BRIEF_PHASES[briefPhase % BRIEF_PHASES.length]}…
            </span>
          </div>
        </div>
      ) : data.brief ? (
        <p className="text-[13.5px] text-[var(--color-ink-soft)] leading-[1.55] m-0">
          {data.brief}
        </p>
      ) : null}
    </>
  );
}

function TaskBody({ data }: { data: FocusCardData }) {
  const duration =
    data.endsAt != null
      ? minutesBetween(data.startsAt, data.endsAt)
      : null;
  return (
    <>
      <div className="flex items-start gap-2.5 mb-1">
        <span
          aria-hidden
          className="inline-block w-[16px] h-[16px] rounded border-[1.5px] border-[var(--color-rule)] bg-white mt-[3px] flex-shrink-0"
        />
        <h3 className="text-[16px] font-medium leading-tight text-[var(--color-ink)]">
          {data.title}
        </h3>
      </div>

      <div className="flex items-center gap-2 mb-2 flex-wrap">
        {duration != null && (
          <span className="inline-block text-[11px] text-[var(--color-muted)] bg-[var(--color-paper-warm)] px-2 py-0.5 rounded">
            {formatDuration(duration)}
          </span>
        )}
        {data.sub && (
          <span className="text-[13px] text-[var(--color-muted)]">
            {data.sub}
          </span>
        )}
      </div>

      {/* v0.4.57: location with pin icon, links to Google Maps. */}
      {data.location && (
        <a
          href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(data.location)}`}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
          className="inline-flex items-start gap-1.5 text-[12.5px] text-[var(--color-muted)] hover:text-[var(--color-accent)] hover:underline mb-2 leading-snug"
          title="Open in Google Maps"
        >
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            className="shrink-0 mt-[2px] text-[var(--color-accent)]"
          >
            <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" />
            <circle cx="12" cy="10" r="3" />
          </svg>
          <span className="truncate">{data.location}</span>
        </a>
      )}

      {data.brief && (
        <p className="text-[13.5px] text-[var(--color-ink-soft)] leading-[1.55] m-0">
          {data.brief}
        </p>
      )}
    </>
  );
}

// ─── small helpers ────────────────────────────────────────────────

function minutesBetween(startIso: string, endIso: string): number {
  return Math.round(
    (new Date(endIso).getTime() - new Date(startIso).getTime()) / 60_000,
  );
}

function formatDuration(mins: number): string {
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m === 0 ? `${h}h focus` : `${h}h ${m}m focus`;
}

function BriefSpinner() {
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
