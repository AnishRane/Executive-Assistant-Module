// /executive — the day-and-week-ahead surface (Phase B).
//
// Layout (top to bottom inside the screen body):
//
//   ScreenHeader   "This week"  +  selected date subtitle
//   WeekStrip      7 day-tiles, today highlighted; click to select
//   DayBriefCard   (selected day's snapshot.narrative_brief, if any)
//   AttentionStrip (only when there are unresolved deltas/conflicts)
//   WeatherBlock   (only when weather data exists for today)
//   FocusCard      "Now"  — closest current/imminent item
//   FocusCard      "Next" — the item after Now
//   LaterList      remaining items, compact rows
//
// Selected-day state lives here; clicking a WeekStrip tile swaps the
// selected date and the body below re-renders with that day's data.
//
// Data plumbing is intentionally Phase-B-conservative: we reuse the
// existing day-scoped hooks (useTodayMeetings / useTodayOoo /
// useActiveTrips) when the selected day is today; for other days we
// derive from useWeekData()'s pre-fetched 7-day aggregate by
// matching dates. The day-scoped hooks expose richer fields (full
// attendee bios, conference link, etc.) needed for FocusCard's
// `sub` line — that's why we keep them for today specifically.

import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import {
  useTodaySnapshot,
  useTodayMeetings,
  useMeetingsForDate,
  useTodayOoo,
  useActiveTrips,
  useWeekData,
  useDeltas,
  useConflicts,
  useSnapshotTimeline,
  useTodayWeather,
  type Delta,
  type Meeting,
  type OooWindow,
  type Trip,
  type TripLeg,
} from "../hooks/useDossier.js";
import { WeekStrip } from "../components/WeekStrip.js";
import { DayBriefCard } from "../components/DayBriefCard.js";
import {
  AttentionStrip,
  type ConflictItemRef,
} from "../components/AttentionStrip.js";
import { WeatherBlock } from "../components/WeatherBlock.js";
import { FocusCard, type FocusCardData } from "../components/FocusCard.js";
import { LaterList } from "../components/LaterList.js";
import { EmptyState } from "../components/EmptyState.js";
import { LoadingState } from "../components/LoadingState.js";
import { MeetingDrawer } from "../components/MeetingDrawer.js";
import { TripDrawer } from "../components/TripDrawer.js";
import { LocaleChip } from "../components/LocaleChip.js";
import { NamePromptBanner } from "../components/NamePromptBanner.js";
import { callTool } from "../lib/api.js";
import { bootstrapTimezone } from "../lib/tzBootstrap.js";
import { formatDateLong, todayDateString } from "../lib/format.js";

export function Today() {
  // ── selected day state ───────────────────────────────────────
  const today = todayDateString();
  const [selectedDate, setSelectedDate] = useState<string>(today);
  const isViewingToday = selectedDate === today;

  // ── drawer routing via ?meeting=/?trip= search params ─────────
  const [searchParams, setSearchParams] = useSearchParams();
  const drawerMeetingId = searchParams.get("meeting");
  const drawerTripId = searchParams.get("trip");
  function closeDrawer() {
    const next = new URLSearchParams(searchParams);
    next.delete("meeting");
    next.delete("trip");
    setSearchParams(next, { replace: true });
  }

  // ── data ─────────────────────────────────────────────────────
  const weekData = useWeekData();
  const snapshot = useTodaySnapshot();
  const todayMeetings = useTodayMeetings();
  const selectedDateMeetings = useMeetingsForDate(selectedDate);
  const todayOoo = useTodayOoo();
  const trips = useActiveTrips();
  const deltas = useDeltas(snapshot.data?.id);
  // v0.4.14: conflicts are keyed by date, not snapshot id.
  const conflicts = useConflicts(selectedDate);
  const timeline = useSnapshotTimeline(snapshot.data?.id);
  const weather = useTodayWeather();
  const queryClient = useQueryClient();

  // ── day brief auto-compose ───────────────────────────────────
  // Fires compose.maybe_create_task once per mount when today has no
  // narrative brief yet. Shows skeleton while the agent writes; polls
  // every 5 s so the brief appears as soon as the agent writes it.
  const hasTriggeredCompose = useRef(false);
  const composeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [composing, setComposing] = useState(false);
  const [composingPhase, setComposingPhase] = useState(0);
  const [composingTimedOut, setComposingTimedOut] = useState(false);

  function stopComposing() {
    setComposing(false);
    setComposingTimedOut(false);
    if (composeTimeoutRef.current) {
      clearTimeout(composeTimeoutRef.current);
      composeTimeoutRef.current = null;
    }
  }

  async function triggerCompose() {
    setComposing(true);
    setComposingPhase(0);
    setComposingTimedOut(false);
    // v0.4.22: 5 min ceiling. Agent compose realistically takes
    // 30–120s; 60s was firing the "taking longer than usual" prompt
    // for normal runs. The brief is persistent in snapshots once
    // written, and the user has a manual Refresh button — the
    // timeout is just a fallback signal that something stalled,
    // not a primary UX state.
    composeTimeoutRef.current = setTimeout(() => {
      setComposing(false);
      setComposingTimedOut(true);
      composeTimeoutRef.current = null;
    }, 300_000);
    try {
      const result = await callTool<
        Record<string, never>,
        { data: { skipped?: boolean; reason?: string } }
      >("executive-assistant.compose.maybe_create_task", {});
      if (result.data?.skipped) {
        // v0.4.42: distinguish skip reasons. "task_inflight" means
        // another caller (install hook, cron, prior UI mount) already
        // created a compose task and the agent is working on it. Keep
        // composing=true so the snapshot poll surfaces the brief as
        // soon as the agent writes it. Other reasons (state_unchanged,
        // ea_agent_missing, tool_registry_unavailable) mean no work is
        // in flight → stop the spinner.
        if (result.data.reason !== "task_inflight") {
          stopComposing();
        }
      }
      // task created → leave composing=true; snapshot poll clears it
    } catch {
      stopComposing();
    }
  }

  useEffect(() => {
    if (!isViewingToday) return;
    if (snapshot.isLoading) return;
    if (snapshot.data?.narrativeBrief) return;
    if (hasTriggeredCompose.current) return;
    hasTriggeredCompose.current = true;
    void triggerCompose();
  }, [isViewingToday, snapshot.isLoading, snapshot.data?.narrativeBrief]);

  // Brief arrived (live or post-timeout) — clear any in-flight state.
  // Calling stopComposing() unconditionally is safe; it's idempotent.
  useEffect(() => {
    if (snapshot.data?.narrativeBrief && (composing || composingTimedOut)) {
      stopComposing();
    }
  }, [snapshot.data?.narrativeBrief, composing, composingTimedOut]);

  useEffect(() => {
    if (!composing) return;
    const t = setInterval(
      () => setComposingPhase((p) => (p + 1) % 3),
      3500,
    );
    return () => clearInterval(t);
  }, [composing]);

  useEffect(() => {
    if (!composing) return;
    // v0.4.37: 5s → 15s. Briefs take 1-3 minutes; 5s polling burned ~36
    // snapshot fetches per brief (per /tmp/ea-trace.log analysis). 15s
    // still feels live (one of ~10 polls per brief) and cuts the noise.
    const t = setInterval(() => {
      queryClient.invalidateQueries({ queryKey: ["ea", "snapshots", "today"] });
    }, 15_000);
    return () => clearInterval(t);
  }, [composing, queryClient]);

  // ── per-meeting brief auto-generation for Now / Next ─────────
  // State and ref declared here (hooks must be top-level). The effects
  // that use now/next are placed after those values are computed below.
  const triggeredBriefsRef = useRef<Set<string>>(new Set());
  const [generatingBriefIds, setGeneratingBriefIds] = useState<Set<string>>(
    new Set(),
  );
  const [briefPhase, setBriefPhase] = useState(0);

  // ── TZ bootstrap (v0.4.13) ───────────────────────────────────
  // Detect browser TZ on mount; if it differs from user.current_location
  // memory, write the new value so the agent's next compose localises
  // correctly. First-time setup also mirrors to user.home_location.
  // Pure logic lives in lib/tzBootstrap; this effect is the wiring.
  const tzBootstrappedRef = useRef(false);
  useEffect(() => {
    if (tzBootstrappedRef.current) return;
    tzBootstrappedRef.current = true;
    void bootstrapTimezone((name, input) => callTool(name, input)).then(
      (result) => {
        if (result.wrote !== "nothing") {
          // Invalidate every EA query so the next render uses the
          // freshly-localised tool responses.
          queryClient.invalidateQueries({ queryKey: ["ea"] });
        }
      },
    );
  }, [queryClient]);

  // ── on-demand conflict scan when (date, snapshot id) changes ───
  // Keyed on the SNAPSHOT id, not just the date, so when the agent
  // composes a fresh snapshot for today (e.g. shortly after install
  // when the v0.4.9 compose task completes) we re-fire the scan
  // against the new snapshot. Without this, an install that creates
  // a fresh snapshot would only get scanned via SKILL.md step 9.5 —
  // and if for any reason the agent skipped that step, no recovery
  // path exists. The recompute is idempotent, so a redundant fire
  // costs nothing. For non-today days we still fall through to the
  // date-only key (no snapshot data hooked there yet).
  const todaySnapshotId = isViewingToday ? snapshot.data?.id ?? null : null;
  const scanKey = isViewingToday
    ? `${selectedDate}:${todaySnapshotId ?? "none"}`
    : selectedDate;
  const scannedKeysRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (scannedKeysRef.current.has(scanKey)) return;
    scannedKeysRef.current.add(scanKey);
    callTool<{ forDate: string }, { data: { recomputed: boolean } }>(
      "executive-assistant.conflicts.recompute_for_date",
      { forDate: selectedDate },
    )
      .then((r) => {
        if (r.data?.recomputed) {
          queryClient.invalidateQueries({ queryKey: ["ea", "conflicts"] });
        }
      })
      .catch(() => {
        // silent — the next snapshot rollover or navigation re-fires
      });
  }, [scanKey, selectedDate, queryClient]);

  // ── weather auto-fetch via browser geolocation ───────────────
  // Runs once per mount when today is selected and no weather row
  // exists yet. Calls fetch_for_date with the device's coords so
  // weather appears immediately without waiting for the agent run.
  const hasTriedWeatherFetch = useRef(false);
  useEffect(() => {
    if (!isViewingToday) return;
    if (weather.isLoading) return;
    if (weather.data) return;
    if (hasTriedWeatherFetch.current) return;
    if (!navigator.geolocation) return;

    hasTriedWeatherFetch.current = true;

    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        const { latitude, longitude } = pos.coords;
        const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
        const locationLabel = tz.includes("/")
          ? tz.split("/").pop()!.replace(/_/g, " ")
          : tz;
        try {
          await callTool<
            {
              forDate: string;
              locationLabel: string;
              latitude: number;
              longitude: number;
              tz: string;
            },
            unknown
          >("executive-assistant.weather.fetch_for_date", {
            forDate: todayDateString(),
            locationLabel,
            latitude,
            longitude,
            tz,
          });
          await queryClient.invalidateQueries({ queryKey: ["ea", "weather"] });
        } catch {
          // nice-to-have — silently skip if the server rejects
        }
      },
      () => {
        // user denied geolocation — that's fine
      },
      { timeout: 10_000 },
    );
  }, [isViewingToday, weather.isLoading, weather.data, queryClient]);

  // v0.4.14: conflicts now reference entity ids directly (ref_a_id /
  // ref_b_id), not timeline_item ids. Map keyed by entity id.
  const conflictItemRefs = useMemo<Map<string, ConflictItemRef>>(() => {
    const out = new Map<string, ConflictItemRef>();
    for (const m of todayMeetings.data?.data ?? []) {
      out.set(m.id, {
        timelineItemId: m.id,
        title: m.title,
        sub: m.organizerEmail ?? undefined,
      });
    }
    for (const o of todayOoo.data?.data ?? []) {
      out.set(o.id, { timelineItemId: o.id, title: o.label ?? "Out of office" });
    }
    for (const t of trips.data ?? []) {
      for (const leg of ((t as Trip & { legs?: TripLeg[] }).legs ?? [])) {
        out.set(leg.id, {
          timelineItemId: leg.id,
          title: `${t.label} (${leg.kind})`,
        });
      }
    }
    return out;
  }, [todayMeetings.data, todayOoo.data, trips.data]);

  const meetingsWithConflict = useMemo<Set<string>>(() => {
    const set = new Set<string>();
    for (const c of conflicts.data ?? []) {
      if (
        c.resolutionStatus === "resolved_by_user" ||
        c.resolutionStatus === "auto_resolved"
      )
        continue;
      if (c.refAKind === "meeting") set.add(c.refAId);
      if (c.refBKind === "meeting") set.add(c.refBId);
    }
    return set;
  }, [conflicts.data]);

  // ── Upcoming hint for quiet days ────────────────────────────
  // When today has nothing scheduled, find the next day in this week
  // that has meetings so the empty-state description can read
  // "Board Meeting tomorrow" instead of a generic placeholder.
  const upcomingHint = useMemo<string | null>(() => {
    if (!isViewingToday || !weekData.data) return null;
    const todayIso = todayDateString();
    const next = weekData.data.find(
      (tile) => tile.date > todayIso && tile.meetingCount > 0,
    );
    if (!next) return null;
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowIso = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, "0")}-${String(tomorrow.getDate()).padStart(2, "0")}`;
    const whenLabel = next.date === tomorrowIso ? "tomorrow" : next.weekday;
    return next.leadItemTitle
      ? `${next.leadItemTitle} is ${whenLabel}`
      : `${next.meetingCount} meeting${next.meetingCount > 1 ? "s" : ""} ${whenLabel}`;
  }, [isViewingToday, weekData.data]);

  // ── Resolve callbacks ───────────────────────────────────────
  async function acknowledgeDelta(deltaId: string) {
    await callTool<{ id: string }, { data: unknown }>(
      "executive-assistant.deltas.acknowledge",
      { id: deltaId },
    );
    await queryClient.invalidateQueries({ queryKey: ["ea", "deltas"] });
  }

  async function resolveConflict(conflictId: string, chosenRefId: string) {
    await callTool<
      { id: string; chosenRefId: string },
      { data: unknown }
    >("executive-assistant.conflicts.resolve", {
      id: conflictId,
      chosenRefId,
    });
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["ea", "conflicts"] }),
      queryClient.invalidateQueries({ queryKey: ["ea", "feedback_signals"] }),
    ]);
  }

  // v0.4.16: retro-capture path. User reports they attended neither.
  // Same tool, chosenRefId omitted; server emits conflict_both_skipped
  // as a distinct feedback signal.
  async function resolveConflictAsBothSkipped(conflictId: string) {
    await callTool<{ id: string }, { data: unknown }>(
      "executive-assistant.conflicts.resolve",
      { id: conflictId },
    );
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["ea", "conflicts"] }),
      queryClient.invalidateQueries({ queryKey: ["ea", "feedback_signals"] }),
    ]);
  }

  // v0.4.16: compute which conflicts have already ended. A conflict
  // is "expired" when BOTH referenced entities' endsAt is in the past.
  // UI uses this to switch from "Which to keep?" to "Which did you
  // attend?" retro-capture mode.
  const expiredConflictIds = useMemo<Set<string>>(() => {
    const now = Date.now();
    const meetingEnds = new Map<string, number | null>();
    for (const m of todayMeetings.data?.data ?? []) {
      meetingEnds.set(m.id, m.endsAt ? new Date(m.endsAt).getTime() : null);
    }
    const oooEnds = new Map<string, number | null>();
    for (const o of todayOoo.data?.data ?? []) {
      oooEnds.set(o.id, o.endsAt ? new Date(o.endsAt).getTime() : null);
    }
    const legEnds = new Map<string, number | null>();
    for (const t of trips.data ?? []) {
      for (const leg of ((t as Trip & { legs?: TripLeg[] }).legs ?? [])) {
        legEnds.set(leg.id, leg.endsAt ? new Date(leg.endsAt).getTime() : null);
      }
    }
    const endFor = (kind: string, id: string): number | null => {
      if (kind === "meeting") return meetingEnds.get(id) ?? null;
      if (kind === "ooo") return oooEnds.get(id) ?? null;
      if (kind === "trip_leg") return legEnds.get(id) ?? null;
      return null;
    };
    const set = new Set<string>();
    for (const c of conflicts.data ?? []) {
      const a = endFor(c.refAKind, c.refAId);
      const b = endFor(c.refBKind, c.refBId);
      if (a != null && b != null && a < now && b < now) set.add(c.id);
    }
    return set;
  }, [conflicts.data, todayMeetings.data, todayOoo.data, trips.data]);

  // ── build the FocusCardData list for the selected day ───────
  const items = useMemo<FocusCardData[]>(() => {
    if (isViewingToday) {
      return buildItemsFromTodayHooks(
        todayMeetings.data?.data ?? [],
        todayOoo.data?.data ?? [],
        trips.data ?? [],
        deltas.data ?? [],
        meetingsWithConflict,
      );
    }
    return buildItemsFromWeekData(
      selectedDate,
      trips.data ?? [],
      selectedDateMeetings.data?.data ?? [],
    );
  }, [
    isViewingToday,
    selectedDate,
    todayMeetings.data,
    selectedDateMeetings.data,
    todayOoo.data,
    trips.data,
    deltas.data,
    meetingsWithConflict,
  ]);

  // Partition into Now / Next / Later
  const { now, next, later } = useMemo(() => {
    const sorted = [...items].sort(
      (a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime(),
    );
    const nowMs = Date.now();
    let nowIdx = -1;
    for (let i = 0; i < sorted.length; i++) {
      const startMs = new Date(sorted[i]!.startsAt).getTime();
      // "Now" = currently happening (started within last 30 min and not yet ended)
      // OR the next upcoming item (closest in the future).
      if (startMs >= nowMs) {
        nowIdx = i;
        break;
      }
    }
    // If everything is past, leave nowIdx = -1.
    // Only promote the first item to "Now" for future days — past days
    // show all items as a plain list with no Now/Next split.
    if (nowIdx === -1 && sorted.length > 0 && selectedDate > today) {
      nowIdx = 0;
    }
    const now = nowIdx >= 0 ? sorted[nowIdx]! : null;
    const next = nowIdx >= 0 && nowIdx + 1 < sorted.length ? sorted[nowIdx + 1]! : null;
    const later = nowIdx >= 0 ? sorted.slice(nowIdx + 2) : sorted;
    return { now, next, later };
  }, [items, isViewingToday, selectedDate, today]);

  // Stable primitives for the brief-generation effects. Any
  // meeting-table row (meeting / event / task / untagged) is eligible
  // for a brief — they all live in __meetings and have a brief column.
  const nowMeetingId =
    now && isMeetingTableKind(now.kind) && !now.brief ? now.refId : null;
  const nextMeetingId =
    next && isMeetingTableKind(next.kind) && !next.brief ? next.refId : null;

  useEffect(() => {
    // v0.4.46 — removed. Today's meeting briefs (including Now + Next)
    // are composed INLINE inside the Day Brief agent run, no separate
    // per-meeting task spawning. This block previously double-spawned,
    // racing the Day Brief task and putting it behind in the serial
    // queue. The Day Brief poll surfaces the brief on each card when
    // it lands.
    if (!isViewingToday || todayMeetings.isLoading) return;
  }, [isViewingToday, todayMeetings.isLoading, nowMeetingId, nextMeetingId]);

  useEffect(() => {
    setGeneratingBriefIds((prev) => {
      if (prev.size === 0) return prev;
      const briefed = new Set(
        (todayMeetings.data?.data ?? [])
          .filter((m) => m.brief)
          .map((m) => m.id),
      );
      const updated = new Set([...prev].filter((id) => !briefed.has(id)));
      return updated.size === prev.size ? prev : updated;
    });
  }, [todayMeetings.data]);

  useEffect(() => {
    if (generatingBriefIds.size === 0) return;
    const t = setInterval(() => setBriefPhase((p) => (p + 1) % 3), 3500);
    return () => clearInterval(t);
  }, [generatingBriefIds.size]);

  useEffect(() => {
    if (generatingBriefIds.size === 0) return;
    // v0.4.37: 5s → 15s. Same reasoning as the snapshots poll above.
    const t = setInterval(() => {
      queryClient.invalidateQueries({ queryKey: ["ea", "meetings"] });
    }, 15_000);
    return () => clearInterval(t);
  }, [generatingBriefIds.size, queryClient]);

  const isLoading =
    weekData.isLoading ||
    (isViewingToday
      ? todayMeetings.isLoading || todayOoo.isLoading || trips.isLoading
      : selectedDateMeetings.isLoading || trips.isLoading);

  return (
    <div className="h-full overflow-y-auto">
      {/* First-time setup prompt — only renders when display_name is unset. */}
      <NamePromptBanner />

      {/* Header */}
      <div className="px-4 sm:px-6 md:px-8 pt-6 sm:pt-8 pb-4 border-b border-[var(--color-rule-soft)]">
        <div className="flex items-start justify-between gap-6">
          <div>
            <h1 className="text-2xl font-semibold leading-tight tracking-[-0.005em] text-[var(--color-ink)] mb-1">
              This week
            </h1>
            <div className="text-[13.5px] text-[var(--color-muted)]">
              {formatDateLong(selectedDate)}
              {!isViewingToday && (
                <button
                  type="button"
                  onClick={() => setSelectedDate(today)}
                  className="ml-3 text-[12px] text-[var(--color-accent)] hover:underline cursor-pointer"
                >
                  Jump to today →
                </button>
              )}
            </div>
          </div>
          <LocaleChip />
        </div>
      </div>

      <div className="px-4 sm:px-6 md:px-8 py-6 pb-20 max-w-[1100px]">
        <WeekStrip
          tiles={weekData.data}
          selectedDate={selectedDate}
          onSelectDate={setSelectedDate}
        />

        {/* Day brief — only for today (older snapshots are History territory) */}
        {isViewingToday && (
          <DayBriefCard
            brief={snapshot.data?.narrativeBrief}
            composedAt={snapshot.data?.generatedAt}
            generating={composing}
            generatingPhase={composingPhase}
            timedOut={composingTimedOut}
            onRetry={() => {
              setComposingTimedOut(false);
              void triggerCompose();
            }}
          />
        )}

        {/* Attention strip — only when actionable signals exist on today */}
        {isViewingToday && (
          <AttentionStrip
            deltas={deltas.data ?? []}
            conflicts={conflicts.data ?? []}
            conflictItemRefs={conflictItemRefs}
            expiredConflictIds={expiredConflictIds}
            onAcknowledgeDelta={acknowledgeDelta}
            onResolveConflict={resolveConflict}
            onResolveConflictAsBothSkipped={resolveConflictAsBothSkipped}
          />
        )}

        {/* Weather — only for today, only when data exists */}
        {isViewingToday && weather.data && <WeatherBlock data={weather.data} />}

        {/* Body */}
        {isLoading ? (
          <LoadingState label="Reading the day…" />
        ) : items.length === 0 ? (
          <EmptyState
            title={isViewingToday ? "A quiet day" : "Nothing on this day"}
            description={
              isViewingToday
                ? upcomingHint
                  ? `Nothing today — ${upcomingHint}. Tap a day above to look ahead.`
                  : "No meetings, travel, or out-of-office windows today. Enjoy the space."
                : "Nothing scheduled here. Tap another day above."
            }
          />
        ) : (
          <>
            {now && (
              <FocusCard
                variant="now"
                data={now}
                generatingBrief={
                  now.kind === "meeting" &&
                  !now.brief &&
                  generatingBriefIds.has(now.refId)
                }
                briefPhase={briefPhase}
              />
            )}
            {next && (
              <FocusCard
                variant="next"
                data={next}
                generatingBrief={
                  next.kind === "meeting" &&
                  !next.brief &&
                  generatingBriefIds.has(next.refId)
                }
                briefPhase={briefPhase}
              />
            )}
            <LaterList items={later} hideWhenEmpty />
          </>
        )}
      </div>

      {/* Drilldown drawers — overlay the day-view when ?meeting= or
          ?trip= is in the URL. Closing the drawer drops the param. */}
      <MeetingDrawer meetingId={drawerMeetingId} onClose={closeDrawer} />
      <TripDrawer tripId={drawerTripId} onClose={closeDrawer} />
    </div>
  );
}

// ─── Helpers ─────────────────────────────────────────────────────

/** True for any kind backed by the `__meetings` table. */
function isMeetingTableKind(
  kind: FocusCardData["kind"],
): kind is "meeting" | "event" | "task" | "untagged" {
  return (
    kind === "meeting" ||
    kind === "event" ||
    kind === "task" ||
    kind === "untagged"
  );
}

/**
 * Build FocusCardData[] from today's day-scoped hook results.
 * Today is the only day where we have richer per-meeting data
 * (briefs, attendees), so the FocusCards' `sub` and `brief` are
 * populated here.
 */
function buildItemsFromTodayHooks(
  meetings: Meeting[],
  ooo: OooWindow[],
  trips: Trip[],
  deltas: Delta[],
  meetingsWithConflict: Set<string>,
): FocusCardData[] {
  const deltasByRefId = new Map<string, Delta>();
  for (const d of deltas) {
    if (d.acknowledgedAt) continue;
    deltasByRefId.set(d.timelineItemId, d);
  }

  const out: FocusCardData[] = [];

  for (const m of meetings) {
    // v0.4.57: location is now a first-class FocusCardData field so the
    // card can render it with a pin icon and link to Google Maps. sub
    // stays focused on organizer / attendees identity.
    const orgEmail = m.organizerEmail ?? "";
    const sub = orgEmail || null;
    const k = m.kind ?? "untagged";
    out.push({
      refId: m.id,
      kind: k === "untagged" ? "untagged" : k,
      title: m.title,
      sub,
      location: m.location ?? null,
      brief: m.brief,
      startsAt: m.startsAt,
      endsAt: m.endsAt,
      tzAbbr: m.tzAbbr ?? null,
      conferenceLink: m.conferenceLink,
      hasDelta: m.lastChangeAt != null && minutesSince(m.lastChangeAt) < 24 * 60,
      hasConflict: meetingsWithConflict.has(m.id),
    });
  }

  for (const t of trips) {
    const legs = (t as Trip & { legs?: TripLeg[] }).legs ?? [];
    for (const leg of legs) {
      if (!leg.startsAt) continue;
      const startDate = leg.startsAt.slice(0, 10);
      if (startDate !== todayDateString()) continue;
      const dest = leg.destinationLocation ? `→ ${leg.destinationLocation}` : "";
      out.push({
        refId: t.id,
        kind: "trip_leg",
        title: `${t.label} ${dest}`.trim(),
        sub:
          leg.kind === "flight"
            ? `Flight ${leg.confirmationCode ?? ""}`.trim()
            : leg.kind === "hotel"
              ? `Hotel · ${leg.confirmationCode ?? ""}`.trim()
              : leg.kind,
        brief: null,
        startsAt: leg.startsAt,
        endsAt: leg.endsAt,
        tzAbbr: leg.tzAbbr ?? null,
      });
    }
  }

  for (const o of ooo) {
    out.push({
      refId: o.id,
      kind: "ooo",
      title: o.label ?? "Out of office",
      sub: null,
      brief: null,
      startsAt: o.startsAt,
      endsAt: o.endsAt,
      tzAbbr: o.tzAbbr ?? null,
    });
  }

  return out;
}

/**
 * For non-today days, build FocusCardData from the per-date meeting
 * fetch (useMeetingsForDate) plus any active trip legs.
 * Brief/attendee fields are not available from the list endpoint, so
 * cards show title + location/organiser sub-line only.
 */
function buildItemsFromWeekData(
  selectedDate: string,
  trips: Trip[],
  meetings: Meeting[],
): FocusCardData[] {
  const out: FocusCardData[] = [];

  for (const m of meetings) {
    // v0.4.57: location is now a separate FocusCardData field. sub stays
    // identity-only (organizer email).
    const sub = m.organizerEmail || null;
    const k = m.kind ?? "untagged";
    out.push({
      refId: m.id,
      kind: k === "untagged" ? "untagged" : k,
      title: m.title,
      sub,
      location: m.location ?? null,
      brief: m.brief,
      startsAt: m.startsAt,
      endsAt: m.endsAt,
      tzAbbr: m.tzAbbr ?? null,
      conferenceLink: m.conferenceLink,
      hasDelta: false,
      hasConflict: false,
    });
  }

  for (const t of trips) {
    const legs = (t as Trip & { legs?: TripLeg[] }).legs ?? [];
    for (const leg of legs) {
      if (!leg.startsAt) continue;
      if (leg.startsAt.slice(0, 10) !== selectedDate) continue;
      const dest = leg.destinationLocation ? `→ ${leg.destinationLocation}` : "";
      out.push({
        refId: t.id,
        kind: "trip_leg",
        title: `${t.label} ${dest}`.trim(),
        sub:
          leg.kind === "flight"
            ? `Flight ${leg.confirmationCode ?? ""}`.trim()
            : leg.kind === "hotel"
              ? `Hotel · ${leg.confirmationCode ?? ""}`.trim()
              : leg.kind,
        brief: null,
        startsAt: leg.startsAt,
        endsAt: leg.endsAt,
        tzAbbr: leg.tzAbbr ?? null,
      });
    }
  }

  return out;
}

function minutesSince(iso: string): number {
  return (Date.now() - new Date(iso).getTime()) / 60_000;
}
