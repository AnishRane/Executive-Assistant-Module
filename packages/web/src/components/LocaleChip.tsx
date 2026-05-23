// LocaleChip — the ambient location/timezone surface in the dossier
// header. Calm. Sits top-right opposite the "This week" title.
//
// States:
//   • At home (current.tz === home.tz)  →  ◷ <city> · <tz>
//   • Traveling (current.tz !== home.tz) →  ✈ <city> · <tz>  + subtitle
//   • Not set yet                       →  Set location  (link)
//
// Click anywhere on the chip → tiny popover anchored below it:
//   CURRENTLY  ◷ <city> / <tz · UTC±offset>
//   HOME       ◷ <city> / <how it was set>
//   Manage in Settings →
//
// Reads its own data via useLocationPrefs(); doesn't take props.
// Implementation is plain React, no popper library.

import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useLocationPrefs, type LocationPref } from "../hooks/useDossier.js";

function tzShortAbbr(tz: string): string {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      timeZoneName: "short",
    }).formatToParts(new Date());
    const short = parts.find((p) => p.type === "timeZoneName")?.value ?? "";
    if (short && !/^(GMT|UTC)[+-]/.test(short)) return short;
    const longParts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      timeZoneName: "long",
    }).formatToParts(new Date());
    const longName =
      longParts.find((p) => p.type === "timeZoneName")?.value ?? "";
    if (longName === "Coordinated Universal Time") return "UTC";
    const words = longName.split(/\s+/).filter((w) => /^[A-Z]/.test(w));
    return words.length ? words.map((w) => w[0]).join("") : short || tz;
  } catch {
    return tz;
  }
}

function tzOffset(tz: string): string {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      timeZoneName: "shortOffset",
    }).formatToParts(new Date());
    const v = parts.find((p) => p.type === "timeZoneName")?.value ?? "";
    return v;
  } catch {
    return "";
  }
}

function ClockIcon({ className }: { className: string }) {
  return (
    <svg
      className={className}
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  );
}

function PlaneIcon({ className }: { className: string }) {
  // Heroicons paper-airplane, rotated to feel "in transit".
  return (
    <svg
      className={className}
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M3.5 13.5l16.5-9-4.5 17-4-7-8-1z" />
    </svg>
  );
}

export function LocaleChip() {
  const { data, isLoading } = useLocationPrefs();
  const [open, setOpen] = useState(false);
  const popoverRef = useRef<HTMLDivElement | null>(null);

  // Click-outside to close.
  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  if (isLoading) {
    // Don't flash — render nothing during the first load.
    return <div className="h-[18px]" />;
  }

  const current = data?.current ?? null;
  const home = data?.home ?? null;

  // First-time-setup state: nothing's set yet.
  if (!current && !home) {
    return (
      <Link
        to="/settings"
        className="text-[12px] font-medium text-[var(--color-accent)] hover:underline cursor-pointer"
      >
        Set location →
      </Link>
    );
  }

  const visible = current ?? home;
  if (!visible) return null;

  const traveling =
    !!current && !!home && current.tz !== home.tz;
  const Icon = traveling ? PlaneIcon : ClockIcon;
  const iconColor = traveling
    ? "text-[var(--color-accent)]"
    : "text-[var(--color-muted)]";
  const abbr = tzShortAbbr(visible.tz);

  return (
    <div className="relative" ref={popoverRef}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex flex-col items-end gap-0 text-right cursor-pointer group"
      >
        <span className="flex items-center gap-1.5">
          <Icon className={`w-[14px] h-[14px] ${iconColor}`} />
          <span className="text-[13.5px] text-[var(--color-ink)] group-hover:underline">
            {visible.label}
          </span>
          <span className="font-mono text-[11px] text-[var(--color-muted)] tracking-[0.04em] uppercase">
            · {abbr}
          </span>
        </span>
        {traveling && home && (
          <span className="text-[11px] text-[var(--color-muted)] italic mt-0.5">
            from home in {home.label}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-2 w-[260px] bg-[var(--color-surface)] border border-[var(--color-rule)] rounded-md shadow-lg z-50 overflow-hidden">
          <PopoverRow label="Currently" loc={current} fallback={home} />
          <div className="border-t border-[var(--color-rule-soft)]" />
          <PopoverRow label="Home" loc={home} fallback={null} />
          <div className="border-t border-[var(--color-rule-soft)] px-4 py-2.5 bg-[var(--color-paper)]">
            <Link
              to="/settings"
              onClick={() => setOpen(false)}
              className="text-[12.5px] font-medium text-[var(--color-accent)] hover:underline cursor-pointer"
            >
              Manage in Settings →
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}

function PopoverRow({
  label,
  loc,
  fallback,
}: {
  label: string;
  loc: LocationPref | null;
  fallback: LocationPref | null;
}) {
  const value = loc ?? fallback;
  return (
    <div className="px-4 py-2.5">
      <div className="text-[10.5px] font-semibold tracking-[0.08em] uppercase text-[var(--color-muted)] mb-1">
        {label}
      </div>
      {value ? (
        <>
          <div className="text-[13.5px] text-[var(--color-ink)] font-medium">
            {value.label}
          </div>
          <div className="font-mono text-[11px] text-[var(--color-muted)] mt-0.5">
            {tzShortAbbr(value.tz)} · {tzOffset(value.tz)}
          </div>
        </>
      ) : (
        <div className="text-[12.5px] text-[var(--color-muted)] italic">
          Not set
        </div>
      )}
    </div>
  );
}
