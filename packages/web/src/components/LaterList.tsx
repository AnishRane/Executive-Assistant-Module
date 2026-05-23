// LaterList — compact list of the remaining items on the selected
// day, after Now + Next have been allocated. Renders as a bordered
// card with a header row and one item per row inside.
//
// Each item row: time gutter + title/subline + optional inline badges
// (travel marker, conflict, delta). Click → drilldown.

import { Link } from "react-router-dom";
import { Badge } from "./Badge.js";
import type { FocusCardData } from "./FocusCard.js";
import { KindChip } from "./KindChip.js";

export interface LaterListProps {
  items: FocusCardData[];
  /** Render no card at all when empty (vs an empty card with header). */
  hideWhenEmpty?: boolean;
  /** v0.1.1: override the "Later today · N more" header. */
  label?: string;
  /** v0.1.1: dim the rows (used for "Earlier today" past items). */
  muted?: boolean;
}

export function LaterList({
  items,
  hideWhenEmpty = false,
  label,
  muted = false,
}: LaterListProps) {
  if (items.length === 0 && hideWhenEmpty) return null;

  return (
    <div className="bg-[var(--color-surface)] border border-[var(--color-rule)] rounded-[12px] overflow-hidden mb-3">
      <div className="px-[18px] py-3 border-b border-[var(--color-rule-soft)] flex items-center justify-between">
        <span className="text-[11px] font-semibold tracking-[0.06em] uppercase text-[var(--color-muted)]">
          {label ?? (items.length > 0
            ? `Later today · ${items.length} more`
            : "Later today")}
        </span>
      </div>

      {items.length === 0 ? (
        <div className="px-[18px] py-4 text-sm text-[var(--color-muted)]">
          Nothing else on the books.
        </div>
      ) : (
        items.map((item) => (
          <LaterRow
            key={`${item.kind}-${item.refId}-${item.startsAt}`}
            item={item}
            muted={muted}
          />
        ))
      )}
    </div>
  );
}

function LaterRow({ item, muted = false }: { item: FocusCardData; muted?: boolean }) {
  const time = new Date(item.startsAt).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const endTime = item.endsAt
    ? new Date(item.endsAt).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      })
    : null;
  const href =
    item.kind === "meeting" ||
    item.kind === "event" ||
    item.kind === "task" ||
    item.kind === "untagged"
      ? `?meeting=${item.refId}`
      : item.kind === "trip_leg"
        ? `?trip=${item.refId}`
        : `/executive`;

  return (
    <Link
      to={href}
      className={`grid grid-cols-[70px_1fr_auto] gap-4 items-center px-[18px] py-3 border-b border-[var(--color-rule-soft)] last:border-b-0 hover:bg-[var(--color-paper-warm)] transition-colors ${
        muted ? "opacity-60" : ""
      }`}
    >
      <div className="font-mono text-[13px] text-[var(--color-ink)] leading-tight">
        {time}
        {endTime && (
          <div className="text-[12px] text-[var(--color-muted)]">
            – {endTime}
            {item.tzAbbr && (
              <span className="ml-1 text-[10.5px] tracking-[0.04em]">
                {item.tzAbbr}
              </span>
            )}
          </div>
        )}
      </div>
      <div className="min-w-0">
        <div className="flex items-center gap-2 mb-[1px]">
          <KindChip kind={item.kind} size="compact" />
          <div className="text-sm text-[var(--color-ink)] truncate">{item.title}</div>
        </div>
        {item.sub && (
          <div className="text-[12px] text-[var(--color-muted)] truncate">
            {item.sub}
          </div>
        )}
        {/* v0.4.57: compact location row with pin icon, links to Maps. */}
        {item.location && (
          <a
            href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(item.location)}`}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            title="Open in Google Maps"
            className="inline-flex items-center gap-1 text-[11.5px] text-[var(--color-muted)] hover:text-[var(--color-accent)] hover:underline truncate max-w-full leading-snug mt-[1px]"
          >
            <svg
              width="11"
              height="11"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              className="shrink-0 text-[var(--color-accent)]"
            >
              <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" />
              <circle cx="12" cy="10" r="3" />
            </svg>
            <span className="truncate">{item.location}</span>
          </a>
        )}
      </div>
      <div className="flex gap-1.5 items-center">
        {/* v0.4.40: small Join icon when the item has a video link.
            stopPropagation so clicking it opens the link instead of
            navigating the parent Link to the meeting drawer. */}
        {item.conferenceLink && (
          <a
            href={item.conferenceLink}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            title="Join video"
            aria-label="Join video"
            className="inline-flex items-center justify-center w-7 h-7 rounded-md text-[var(--color-accent)] hover:bg-[var(--color-accent-tint)] transition-colors"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
            >
              <path d="M23 7l-7 5 7 5V7z" />
              <rect x="1" y="5" width="15" height="14" rx="2" />
            </svg>
          </a>
        )}
        {item.hasConflict && <Badge variant="conflict">Conflict</Badge>}
        {item.hasDelta && <Badge variant="changed">Changed</Badge>}
      </div>
    </Link>
  );
}
