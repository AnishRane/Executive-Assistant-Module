// Drawer-content for a single trip. Mounted by Today.tsx when the
// `?trip=<id>` search param is present. Shows the trip header +
// each leg in chronological order with confirmation code, times,
// and locations.

import { Drawer } from "./Drawer.js";
import { EmptyState } from "./EmptyState.js";
import { LoadingState } from "./LoadingState.js";
import { useTrip } from "../hooks/useDossier.js";

interface TripDrawerProps {
  tripId: string | null;
  onClose: () => void;
}

export function TripDrawer({ tripId, onClose }: TripDrawerProps) {
  const open = !!tripId;
  const { data: trip, isLoading } = useTrip(tripId ?? undefined);

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={trip?.label ?? "Loading trip…"}
      subtitle={trip ? tripSubtitle(trip) : null}
    >
      {isLoading ? (
        <LoadingState label="Loading trip…" compact />
      ) : !trip ? (
        <EmptyState
          title="Trip not found"
          description="It may have been removed, or the link is stale. Close this drawer to return to today."
          compact
        />
      ) : (
        <div className="flex flex-col gap-5">
          <section>
            <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--color-muted)] mb-2">
              Legs · {trip.legs.length}
            </div>
            <ul className="m-0 p-0 list-none flex flex-col gap-2">
              {trip.legs
                .slice()
                .sort((a, b) => {
                  const at = a.startsAt ? new Date(a.startsAt).getTime() : 0;
                  const bt = b.startsAt ? new Date(b.startsAt).getTime() : 0;
                  return at - bt;
                })
                .map((leg) => (
                  <li
                    key={leg.id}
                    className="border border-[var(--color-rule-soft)] rounded-md px-3.5 py-3"
                  >
                    <div className="flex items-baseline gap-2 flex-wrap mb-1">
                      <span className="text-[10.5px] font-semibold uppercase tracking-[0.06em] text-[var(--color-accent)]">
                        {leg.kind}
                      </span>
                      {leg.confirmationCode && (
                        <span className="font-mono text-[12px] text-[var(--color-muted)]">
                          {leg.confirmationCode}
                        </span>
                      )}
                    </div>
                    <div className="text-[14px] text-[var(--color-ink)] font-medium">
                      {legTitle(leg)}
                    </div>
                    {(leg.startsAt || leg.endsAt) && (
                      <div className="text-[12.5px] text-[var(--color-muted)] mt-1">
                        {legTimeRange(leg)}
                      </div>
                    )}
                    {leg.provider && (
                      <div className="text-[12px] text-[var(--color-muted)] mt-0.5">
                        Provider · {leg.provider}
                      </div>
                    )}
                  </li>
                ))}
            </ul>
          </section>
        </div>
      )}
    </Drawer>
  );
}

function tripSubtitle(t: {
  origin: string | null;
  destination: string | null;
  startsOn: string | null;
  endsOn: string | null;
  status: string;
}): string {
  const route =
    t.origin && t.destination
      ? `${t.origin} → ${t.destination}`
      : t.destination ?? t.origin ?? "";
  const dates = t.startsOn
    ? t.endsOn && t.endsOn !== t.startsOn
      ? `${t.startsOn} – ${t.endsOn}`
      : t.startsOn
    : "";
  return [route, dates, t.status].filter(Boolean).join(" · ");
}

function legTitle(leg: {
  originLocation: string | null;
  destinationLocation: string | null;
  kind: string;
}): string {
  if (leg.originLocation && leg.destinationLocation) {
    return `${leg.originLocation} → ${leg.destinationLocation}`;
  }
  if (leg.destinationLocation) return leg.destinationLocation;
  if (leg.originLocation) return leg.originLocation;
  return leg.kind;
}

function legTimeRange(leg: {
  startsAt: string | null;
  endsAt: string | null;
}): string {
  const fmt = (iso: string) =>
    new Date(iso).toLocaleString([], {
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
  if (leg.startsAt && leg.endsAt) return `${fmt(leg.startsAt)} → ${fmt(leg.endsAt)}`;
  if (leg.startsAt) return fmt(leg.startsAt);
  return "";
}
