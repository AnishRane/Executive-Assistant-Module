// Data-fetching hooks for the dossier surface.
// Wraps the EA tools via react-query. Components consume these
// instead of hitting the API directly so loading/error states are
// uniform.

import { useQuery } from "@tanstack/react-query";
import { callTool } from "../lib/api.js";
import { dayBounds, todayDateString } from "../lib/format.js";

// ─── Types mirroring the EA tool response shapes ───────────────

export interface Snapshot {
  id: string;
  tenantId: string;
  snapshotDate: string;
  generatedAt: string;
  narrativeBrief: string | null;
  status: string;
}

export interface Meeting {
  id: string;
  tenantId: string;
  googleEventId: string;
  title: string;
  startsAt: string;
  endsAt: string;
  location: string | null;
  conferenceLink: string | null;
  organizerEmail: string | null;
  description: string | null;
  brief: string | null;
  userNotes: string | null;
  gmailThreadId: string | null;
  lastChangeAt: string | null;
  // v0.4.28+ item categorization. Server-classified at sync time.
  // Untagged rows fall back to a neutral card render.
  kind?: "meeting" | "event" | "task" | "untagged";
  kindLocked?: boolean;
  // v0.4.13+ server-localized fields (present when the server could
  // resolve the tenant's timezone; absent when prefs aren't set yet).
  startsAtLocal?: string;
  endsAtLocal?: string | null;
  startsAtLocalLong?: string;
  dayPart?: "morning" | "afternoon" | "evening" | "night";
  tzAbbr?: string;
  tzIana?: string;
}

export interface MeetingAttendee {
  id: string;
  meetingId: string;
  email: string;
  name: string | null;
  title: string | null;
  company: string | null;
  bio: string | null;
  isExternal: boolean;
}

export type MeetingWithAttendees = Meeting & { attendees: MeetingAttendee[] };

export interface Trip {
  id: string;
  tenantId: string;
  label: string;
  origin: string | null;
  destination: string | null;
  startsOn: string | null;
  endsOn: string | null;
  status: string;
}

export interface TripLeg {
  id: string;
  tripId: string;
  kind: "flight" | "hotel" | "ground";
  confirmationCode: string | null;
  provider: string | null;
  startsAt: string | null;
  endsAt: string | null;
  originLocation: string | null;
  destinationLocation: string | null;
  currentState: Record<string, unknown>;
  sourceMessageIds: string[];
  lastReconciledAt: string | null;
  // v0.4.26 server-localized fields, only set when startsAt is non-null
  // and tenant prefs resolve. Some legs (one-way bookings) have no
  // startsAt at all and thus no localized fields.
  startsAtLocal?: string;
  endsAtLocal?: string | null;
  startsAtLocalLong?: string;
  dayPart?: "morning" | "afternoon" | "evening" | "night";
  tzAbbr?: string;
  tzIana?: string;
}

export type TripWithLegs = Trip & { legs: TripLeg[] };

export interface OooWindow {
  id: string;
  tenantId: string;
  startsAt: string;
  endsAt: string;
  source: string;
  sourceRefId: string | null;
  label: string | null;
  // v0.4.26 server-localized fields (present when prefs resolve).
  startsAtLocal?: string;
  endsAtLocal?: string | null;
  startsAtLocalLong?: string;
  dayPart?: "morning" | "afternoon" | "evening" | "night";
  tzAbbr?: string;
  tzIana?: string;
}

// ─── Hooks ──────────────────────────────────────────────────────

interface ListResult<T> {
  data: T[];
  total: number;
  limit: number;
  offset: number;
}

interface OneResult<T> {
  data: T;
}

/**
 * Today's snapshot. Polls every 60s so a fresh compose (from the
 * always-fresh cron, or from an install-time task completing) shows
 * up automatically — the on-demand conflict scan in Today.tsx keys
 * on this snapshot's id, so refreshing it triggers a fresh scan.
 */
export function useTodaySnapshot() {
  return useQuery({
    queryKey: ["ea", "snapshots", "today"],
    refetchInterval: 60_000,
    queryFn: async (): Promise<Snapshot | null> => {
      const r = await callTool<{ limit: number }, ListResult<Snapshot>>(
        "executive-assistant.snapshots.list",
        { limit: 1 },
      );
      const today = todayDateString();
      const hit = r.data.find((s) => s.snapshotDate === today);
      return hit ?? null;
    },
  });
}

export function useSnapshotHistory(limit = 90) {
  return useQuery({
    queryKey: ["ea", "snapshots", "history", limit],
    queryFn: async () => {
      return callTool<{ limit: number }, ListResult<Snapshot>>(
        "executive-assistant.snapshots.list",
        { limit },
      );
    },
  });
}

export function useTodayMeetings() {
  return useQuery({
    queryKey: ["ea", "meetings", "today"],
    queryFn: async () => {
      const bounds = dayBounds(todayDateString());
      return callTool<typeof bounds, ListResult<Meeting>>(
        "executive-assistant.meetings.list",
        bounds,
      );
    },
  });
}

export function useMeetingsForDate(date: string) {
  return useQuery({
    queryKey: ["ea", "meetings", date],
    queryFn: async () => {
      const bounds = dayBounds(date);
      return callTool<typeof bounds, ListResult<Meeting>>(
        "executive-assistant.meetings.list",
        bounds,
      );
    },
  });
}

export function useTodayOoo() {
  return useQuery({
    queryKey: ["ea", "ooo", "today"],
    queryFn: async () => {
      const bounds = dayBounds(todayDateString());
      return callTool<typeof bounds, ListResult<OooWindow>>(
        "executive-assistant.ooo.list",
        bounds,
      );
    },
  });
}

export function useActiveTrips() {
  return useQuery({
    queryKey: ["ea", "trips", "active"],
    queryFn: async () => {
      // Phase 1 doesn't filter on status server-side for "active set" —
      // we fetch planned + in_progress separately and merge.
      const [planned, inProg] = await Promise.all([
        callTool<{ status: "planned"; limit: number }, ListResult<Trip>>(
          "executive-assistant.trips.list",
          { status: "planned", limit: 50 },
        ),
        callTool<{ status: "in_progress"; limit: number }, ListResult<Trip>>(
          "executive-assistant.trips.list",
          { status: "in_progress", limit: 50 },
        ),
      ]);
      return [...planned.data, ...inProg.data];
    },
  });
}

export function useMeeting(id: string | undefined) {
  return useQuery({
    queryKey: ["ea", "meetings", id],
    enabled: !!id,
    queryFn: async () => {
      const r = await callTool<{ meetingId: string }, OneResult<MeetingWithAttendees>>(
        "executive-assistant.meetings.get",
        { meetingId: id! },
      );
      return r.data;
    },
  });
}

export function useTrip(id: string | undefined) {
  return useQuery({
    queryKey: ["ea", "trips", id],
    enabled: !!id,
    queryFn: async () => {
      const r = await callTool<{ id: string }, OneResult<TripWithLegs>>(
        "executive-assistant.trips.get",
        { id: id! },
      );
      return r.data;
    },
  });
}

// ─── Phase 4: deltas + conflicts ───────────────────────────────

export interface Delta {
  id: string;
  snapshotId: string;
  timelineItemId: string;
  deltaKind: string;
  summary: string | null;
  meta: Record<string, unknown>;
  occurredAt: string;
  acknowledgedAt: string | null;
}

export interface Conflict {
  id: string;
  tenantId: string;
  forDate: string;
  refAKind: "meeting" | "ooo" | "trip_leg";
  refAId: string;
  refBKind: "meeting" | "ooo" | "trip_leg";
  refBId: string;
  overlapMinutes: number;
  detectedAt: string;
  resolutionStatus:
    | "unresolved"
    | "acknowledged"
    | "resolved_by_user"
    | "auto_resolved";
  resolvedChoice: string | null;
}

export interface TimelineItemRow {
  id: string;
  snapshotId: string;
  kind: "meeting" | "trip_leg" | "ooo";
  refId: string;
  startsAt: string;
  endsAt: string | null;
  elevated: boolean;
  elevationReason: "imminent" | "changed" | "agent_flag" | null;
  sortOrder: number;
}

export function useSnapshotTimeline(snapshotId: string | undefined) {
  return useQuery({
    queryKey: ["ea", "timeline", snapshotId],
    enabled: !!snapshotId,
    refetchInterval: 60_000,
    queryFn: async () => {
      const r = await callTool<
        { snapshotId: string },
        { data: TimelineItemRow[]; total: number }
      >("executive-assistant.timeline_items.list", { snapshotId: snapshotId! });
      return r.data;
    },
  });
}

/**
 * Active deltas for a snapshot. Refetches every 60s so a meeting
 * reschedule on the server side surfaces within a minute.
 */
export function useDeltas(snapshotId: string | undefined) {
  return useQuery({
    queryKey: ["ea", "deltas", snapshotId],
    enabled: !!snapshotId,
    refetchInterval: 60_000,
    queryFn: async () => {
      const r = await callTool<
        { snapshotId: string },
        { data: Delta[]; total: number }
      >("executive-assistant.deltas.list", { snapshotId: snapshotId! });
      return r.data;
    },
  });
}

/**
 * Active (unresolved) conflicts for a given date. v0.4.14: conflicts
 * are no longer scoped to a snapshot — they're a property of the live
 * calendar state. Refetches every 60s.
 */
export function useConflicts(forDate: string | undefined) {
  return useQuery({
    queryKey: ["ea", "conflicts", forDate],
    enabled: !!forDate,
    refetchInterval: 60_000,
    queryFn: async () => {
      const r = await callTool<
        { forDate: string },
        { data: Conflict[]; total: number }
      >("executive-assistant.conflicts.list", { forDate: forDate! });
      return r.data;
    },
  });
}

// ─── Phase 5: feedback signals ─────────────────────────────────

export interface FeedbackSignal {
  id: string;
  tenantId: string;
  signalKind: string;
  subjectKind: string;
  subjectId: string;
  value: Record<string, unknown>;
  createdByUserId: string | null;
  createdAt: string;
}

// ─── Phase 6: weather ──────────────────────────────────────────

export interface WeatherSnapshot {
  id: string;
  tenantId: string;
  forDate: string;
  locationLabel: string;
  latitude: number;
  longitude: number;
  tz: string;

  summary: string | null;
  conditionCode: "clear" | "cloudy" | "rain" | "snow" | "storm" | "fog" | null;
  conditionLabel: string | null;

  tempHighC: number | null;
  tempLowC: number | null;
  tempApparentHighC: number | null;
  tempApparentLowC: number | null;

  precipProbabilityMax: number | null;
  precipitationMm: number | null;

  windSpeedMaxKmh: number | null;
  windGustsMaxKmh: number | null;

  uvIndexMax: number | null;

  sunrise: string | null;
  sunset: string | null;

  fetchedAt: string;
}

// ─── Phase B: week-strip aggregation ───────────────────────────

export interface DayTile {
  /** YYYY-MM-DD */
  date: string;
  weekday: string; // "Mon", "Tue", ...
  dayOfMonth: number;
  isToday: boolean;
  meetingCount: number;
  oooCount: number;
  /** A single short string describing the most-notable item, or null for empty days. */
  leadItemTitle: string | null;
  /** Whether any markers should render. */
  hasTravel: boolean;
  hasOoo: boolean;
  hasConflict: boolean;
}

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

/**
 * Compute the Monday-start of the week containing `now` (in local time).
 * Returns the YYYY-MM-DD string for that Monday.
 */
function startOfWeekMonday(now: Date): Date {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  const dow = d.getDay(); // 0 = Sun, 1 = Mon, ...
  const offset = dow === 0 ? -6 : 1 - dow; // pull back to Monday
  d.setDate(d.getDate() + offset);
  return d;
}

function isoDateLocal(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * Aggregates meetings + trip legs + OOO for the next 7 days starting
 * Monday, grouped by day. Used by WeekStrip. Polls every 60s to pick
 * up sync changes.
 *
 * Implementation notes:
 * - Fetches a wide window (Monday 00:00 → Sunday 23:59) via the
 *   existing meetings.list / ooo.list / trips.list tools. No new
 *   server-side aggregation needed — client groups in-memory.
 * - "Lead item" = first meeting of the day by start time, OR first
 *   trip leg if no meetings, OR OOO label, in that priority order.
 * - Markers: hasTravel if any trip leg overlaps the day; hasOoo if
 *   any OOO window starts that day; hasConflict left false in v1
 *   (would require conflicts.list per snapshot; deferred).
 */
export function useWeekData() {
  return useQuery({
    queryKey: ["ea", "week-data"],
    refetchInterval: 60_000,
    queryFn: async (): Promise<DayTile[]> => {
      const now = new Date();
      const monday = startOfWeekMonday(now);
      const sunday = new Date(monday);
      sunday.setDate(sunday.getDate() + 6);
      sunday.setHours(23, 59, 59, 999);

      const [meetingsRes, oooRes, trips] = await Promise.all([
        callTool<{ startsAfter: string; endsBefore: string; limit: number }, ListResult<Meeting>>(
          "executive-assistant.meetings.list",
          {
            startsAfter: monday.toISOString(),
            endsBefore: sunday.toISOString(),
            limit: 500,
          },
        ),
        callTool<{ startsAfter: string; endsBefore: string; limit: number }, ListResult<OooWindow>>(
          "executive-assistant.ooo.list",
          {
            startsAfter: monday.toISOString(),
            endsBefore: sunday.toISOString(),
            limit: 500,
          },
        ),
        // Active trips with their legs — reuse the active-trips list shape.
        (async () => {
          const [planned, inProg] = await Promise.all([
            callTool<{ status: "planned"; limit: number }, ListResult<Trip>>(
              "executive-assistant.trips.list",
              { status: "planned", limit: 100 },
            ),
            callTool<{ status: "in_progress"; limit: number }, ListResult<Trip>>(
              "executive-assistant.trips.list",
              { status: "in_progress", limit: 100 },
            ),
          ]);
          return [...planned.data, ...inProg.data];
        })(),
      ]);

      const meetingsByDay = new Map<string, Meeting[]>();
      for (const m of meetingsRes.data) {
        const day = isoDateLocal(new Date(m.startsAt));
        const arr = meetingsByDay.get(day) ?? [];
        arr.push(m);
        meetingsByDay.set(day, arr);
      }
      const oooByDay = new Map<string, OooWindow[]>();
      for (const o of oooRes.data) {
        const day = isoDateLocal(new Date(o.startsAt));
        const arr = oooByDay.get(day) ?? [];
        arr.push(o);
        oooByDay.set(day, arr);
      }
      // Trip legs span multiple days — mark every day in the leg's range.
      const tripDays = new Set<string>();
      for (const t of trips) {
        const legs = (t as Trip & { legs?: TripLeg[] }).legs ?? [];
        for (const leg of legs) {
          if (!leg.startsAt) continue;
          const startMs = new Date(leg.startsAt).getTime();
          const endMs = leg.endsAt ? new Date(leg.endsAt).getTime() : startMs;
          for (let t = startMs; t <= endMs; t += 86_400_000) {
            tripDays.add(isoDateLocal(new Date(t)));
          }
        }
      }

      const todayIso = isoDateLocal(now);
      const tiles: DayTile[] = [];
      for (let i = 0; i < 7; i++) {
        const d = new Date(monday);
        d.setDate(monday.getDate() + i);
        const day = isoDateLocal(d);
        const dayMeetings = (meetingsByDay.get(day) ?? []).sort(
          (a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime(),
        );
        const dayOoo = oooByDay.get(day) ?? [];
        const lead =
          dayMeetings[0]?.title ??
          dayOoo[0]?.label ??
          (tripDays.has(day) ? "Travel day" : null);

        tiles.push({
          date: day,
          weekday: WEEKDAYS[i]!,
          dayOfMonth: d.getDate(),
          isToday: day === todayIso,
          meetingCount: dayMeetings.length,
          oooCount: dayOoo.length,
          leadItemTitle: lead,
          hasTravel: tripDays.has(day),
          hasOoo: dayOoo.length > 0,
          hasConflict: false, // deferred to a future per-day snapshot lookup
        });
      }
      return tiles;
    },
  });
}

// ─── Phase 7: location preferences ────────────────────────────

export interface LocationPref {
  label: string;
  tz: string;
  latitude?: number;
  longitude?: number;
}

/**
 * Reads the two preference keys that drive the LocaleChip:
 *   - current_location  — where the user is right now (auto-updated
 *                         by the browser TZ bootstrap)
 *   - home_location     — anchor; set once, edited rarely
 *
 * Either may be null when the user hasn't completed setup. Polls
 * every 60s so a travel state-change (e.g. opening the dossier from
 * a new city) propagates without a hard refresh.
 */
export function useLocationPrefs() {
  return useQuery({
    queryKey: ["ea", "preferences", "locations"],
    // v0.4.37 — preferences barely change; let multiple consumers
    // share a cached result for 5 min instead of each re-fetching.
    staleTime: 5 * 60_000,
    refetchInterval: 5 * 60_000,
    queryFn: async () => {
      const fetchOne = async (key: string): Promise<LocationPref | null> => {
        try {
          const r = await callTool<
            { key: string },
            { data: { value: LocationPref | null } }
          >("executive-assistant.preferences.get", { key });
          return r.data.value ?? null;
        } catch {
          return null;
        }
      };
      const [current, home] = await Promise.all([
        fetchOne("current_location"),
        fetchOne("home_location"),
      ]);
      return { current, home };
    },
  });
}

/**
 * Reads the user's configured display name from preferences. Returns
 * the string when set, null when unset (banner / setup prompt path).
 * Polls every 60s like the other preferences hooks.
 */
export function useDisplayName() {
  return useQuery({
    queryKey: ["ea", "preferences", "display_name"],
    // v0.4.37 — display name doesn't change minute-to-minute.
    staleTime: 5 * 60_000,
    refetchInterval: 5 * 60_000,
    queryFn: async (): Promise<string | null> => {
      try {
        const r = await callTool<
          { key: string },
          { data: { value: { name?: string } | null } }
        >("executive-assistant.preferences.get", { key: "display_name" });
        const name = r.data?.value?.name;
        return typeof name === "string" && name.length > 0 ? name : null;
      } catch {
        return null;
      }
    },
  });
}

export function useTodayWeather() {
  return useQuery({
    queryKey: ["ea", "weather", "today"],
    // v0.4.37 — weather row is rewritten by the agent during compose;
    // outside of that it changes ~once per day. 15 min keeps it
    // reasonably fresh without burning calls.
    staleTime: 15 * 60_000,
    refetchInterval: 15 * 60_000,
    queryFn: async (): Promise<WeatherSnapshot | null> => {
      const r = await callTool<
        { forDate: string },
        { data: WeatherSnapshot | null }
      >("executive-assistant.weather.get_for_snapshot", {
        forDate: todayDateString(),
      });
      return r.data;
    },
  });
}

export function useFeedbackSignals(limit = 50) {
  return useQuery({
    queryKey: ["ea", "feedback_signals", limit],
    refetchInterval: 60_000,
    queryFn: async () => {
      const r = await callTool<
        { limit: number },
        { data: FeedbackSignal[]; total: number }
      >("executive-assistant.feedback_signals.list", { limit });
      return r;
    },
  });
}
