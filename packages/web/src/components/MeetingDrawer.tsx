// Drawer-content for a single meeting. Mounted by Today.tsx when the
// `?meeting=<id>` search param is present. Lean rewrite of the old
// MeetingDrilldown — shell tokens, no font-mono on labels, inline
// brief editor, attendees list, action items.
//
// Brief save: textarea blurs → callTool('meetings.set_brief'). React
// Query invalidates the meeting and feedback_signals queries so the
// FocusCard's brief and the Memory page both reflect the edit.
//
// Brief generation: auto-triggered when no brief exists. No button —
// the skeleton appears immediately and polling wakes the UI when the
// agent finishes writing.

import { useState, useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Drawer } from "./Drawer.js";
import { EmptyState } from "./EmptyState.js";
import { LoadingState } from "./LoadingState.js";
import { useMeeting } from "../hooks/useDossier.js";
import { callTool } from "../lib/api.js";
import { KindChip, type ItemKindUi } from "./KindChip.js";
import { BriefMarkdown } from "./BriefMarkdown.js";

type EditableKind = "meeting" | "event" | "task" | "untagged";
const EDITABLE_KINDS: EditableKind[] = ["meeting", "event", "task", "untagged"];

const BRIEF_PHASES = [
  "Reading agenda",
  "Recalling context",
  "Drafting brief",
];

interface MeetingDrawerProps {
  meetingId: string | null;
  onClose: () => void;
}

export function MeetingDrawer({ meetingId, onClose }: MeetingDrawerProps) {
  const open = !!meetingId;
  const { data: meeting, isLoading } = useMeeting(meetingId ?? undefined);
  const queryClient = useQueryClient();

  const [notesDraft, setNotesDraft] = useState<string>("");
  const [savingNotes, setSavingNotes] = useState(false);
  const [generatingBrief, setGeneratingBrief] = useState(false);
  const [briefPhase, setBriefPhase] = useState(0);

  // Tracks meeting IDs we've already fired generation for this session.
  const triggeredRef = useRef<Set<string>>(new Set());

  // Sync notes draft when meeting loads / agent rewrites brief.
  useEffect(() => {
    setNotesDraft(meeting?.userNotes ?? "");
    // Brief arrived while skeleton was showing — stop the animation.
    if (meeting?.brief && generatingBrief) {
      setGeneratingBrief(false);
    }
  }, [meeting?.id, meeting?.brief, meeting?.userNotes, generatingBrief]);

  // Auto-trigger lazy brief generation for FUTURE meetings only.
  //
  // v0.4.46 — today's meetings are owned by the Day Brief agent run,
  // which writes their briefs inline as part of composing the day's
  // narrative. Auto-triggering here for today's meetings would race
  // the Day Brief task and double-spawn. For future meetings, this is
  // the lazy on-click path: user clicks Friday's meeting drawer →
  // single task fires → brief appears in ~30-60s.
  useEffect(() => {
    if (!meeting || triggeredRef.current.has(meeting.id)) return;
    triggeredRef.current.add(meeting.id);
    if (meeting.brief) return;
    // Guard: skip today's meetings. Day Brief handles them inline.
    const meetingDay = new Date(meeting.startsAt).toDateString();
    const todayDay = new Date().toDateString();
    if (meetingDay === todayDay) return;
    setGeneratingBrief(true);
    setBriefPhase(0);
    callTool<{ meetingIds: string[] }, { data: unknown }>(
      "executive-assistant.compose.prepare_meeting_briefs",
      { meetingIds: [meeting.id] },
    ).catch(() => setGeneratingBrief(false));
  }, [meeting?.id]);

  // Cycle status phrases while generating.
  useEffect(() => {
    if (!generatingBrief) return;
    const t = setInterval(
      () => setBriefPhase((p) => (p + 1) % BRIEF_PHASES.length),
      3500,
    );
    return () => clearInterval(t);
  }, [generatingBrief]);

  // v0.4.48: poll every 15 s while the brief is missing OR a fetch is
  // in flight. For today's meetings the Day Brief run writes it in the
  // background, so we need to poll even when generatingBrief is false.
  // Polling stops once the brief lands.
  useEffect(() => {
    if (!meetingId) return;
    if (meeting?.brief) return;
    const t = setInterval(() => {
      queryClient.invalidateQueries({ queryKey: ["ea", "meetings", meetingId] });
    }, 15_000);
    return () => clearInterval(t);
  }, [meetingId, meeting?.brief, queryClient]);

  async function saveNotes() {
    if (!meeting) return;
    if (notesDraft === (meeting.userNotes ?? "")) return;
    setSavingNotes(true);
    try {
      await callTool<{ meetingId: string; notes: string }, { data: unknown }>(
        "executive-assistant.meetings.set_notes",
        { meetingId: meeting.id, notes: notesDraft },
      );
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["ea", "meetings"] }),
        queryClient.invalidateQueries({ queryKey: ["ea", "feedback_signals"] }),
      ]);
    } catch {
      setNotesDraft(meeting.userNotes ?? "");
    } finally {
      setSavingNotes(false);
    }
  }

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={meeting?.title ?? "Loading meeting…"}
      subtitle={meeting ? meetingSubtitle(meeting) : null}
    >
      {isLoading ? (
        <LoadingState label="Loading meeting…" compact />
      ) : !meeting ? (
        <EmptyState
          title="Meeting not found"
          description="It may have been removed from the calendar, or the link is stale. Close this drawer to return to today."
          compact
        />
      ) : (
        <div className="flex flex-col gap-5">
          {/* Agenda — Google Calendar description */}
          {meeting.description && (
            <section>
              <SectionLabel>Agenda</SectionLabel>
              <p className="text-[14px] leading-[1.6] text-[var(--color-ink)] m-0 whitespace-pre-wrap">
                {meeting.description}
              </p>
            </section>
          )}

          {/* Categorize — user override of the auto-classified kind */}
          <CategorizeSection
            meetingId={meeting.id}
            currentKind={(meeting.kind ?? "untagged") as EditableKind}
            kindLocked={!!meeting.kindLocked}
          />

          {/* Prep brief — read-only, agent-owned */}
          <section>
            <div className="flex items-baseline justify-between mb-2">
              <SectionLabel>Prep brief · the agent's read</SectionLabel>
              {meeting.brief && !generatingBrief && (
                <button
                  type="button"
                  onClick={async () => {
                    setGeneratingBrief(true);
                    setBriefPhase(0);
                    try {
                      await callTool<
                        { meetingIds: string[] },
                        { data: unknown }
                      >(
                        "executive-assistant.compose.prepare_meeting_briefs",
                        { meetingIds: [meeting.id] },
                      );
                    } catch {
                      setGeneratingBrief(false);
                    }
                  }}
                  className="text-[11px] font-medium text-[var(--color-accent)] hover:underline cursor-pointer"
                  title="Regenerate this brief with the latest calendar and thread context"
                >
                  Refresh →
                </button>
              )}
            </div>
            {meeting.brief ? (
              // v0.4.49: prep briefs may use markdown headings + bold.
              <BriefMarkdown body={meeting.brief} />
            ) : (
              // v0.4.48 — when the brief hasn't landed yet, show the
              // same pulsing skeleton whether the fetch is explicit
              // (Refresh / future-meeting auto-trigger) or implicit
              // (today's meeting, the Day Brief run is writing it in
              // the background). Visual continuity tells the user the
              // module is working on it without making them guess.
              <BriefSkeleton generating={generatingBrief} phase={briefPhase} />
            )}
          </section>

          {/* Your notes — user-owned, editable */}
          <section>
            <div className="flex items-baseline justify-between mb-2">
              <SectionLabel>Your notes</SectionLabel>
              {savingNotes && (
                <span className="text-[11px] text-[var(--color-muted)]">Saving…</span>
              )}
            </div>
            <textarea
              value={notesDraft}
              onChange={(e) => setNotesDraft(e.target.value)}
              onBlur={saveNotes}
              placeholder="Anything you want to remember about this meeting — context, prep cues, follow-ups."
              className="w-full min-h-[88px] text-[14px] leading-[1.55] text-[var(--color-ink)] placeholder:text-[var(--color-muted)] placeholder:italic bg-[var(--color-paper)] border border-[var(--color-rule)] rounded-md px-3 py-2 font-sans focus:outline-none focus:border-[var(--color-accent)] focus:ring-2 focus:ring-[var(--color-accent-tint)] resize-y"
            />
          </section>

          {/* Attendees */}
          {meeting.attendees && meeting.attendees.length > 0 && (
            <section>
              <SectionLabel>Attendees · {meeting.attendees.length}</SectionLabel>
              <ul className="m-0 p-0 list-none flex flex-col gap-2">
                {meeting.attendees.map((a) => (
                  <li
                    key={a.id}
                    className="border border-[var(--color-rule-soft)] rounded-md px-3 py-2"
                  >
                    <div className="flex items-baseline gap-2 flex-wrap">
                      <span className="text-[14px] text-[var(--color-ink)] font-medium">
                        {a.name ?? a.email}
                      </span>
                      {a.isExternal && (
                        <span className="text-[10px] font-semibold tracking-[0.06em] uppercase text-[var(--color-accent)]">
                          External
                        </span>
                      )}
                    </div>
                    <div className="text-[12px] text-[var(--color-muted)]">
                      {a.email}
                      {a.title && ` · ${a.title}`}
                      {a.company && ` · ${a.company}`}
                    </div>
                    {a.bio && (
                      <div className="text-[12.5px] text-[var(--color-ink-soft)] mt-1.5 leading-[1.5]">
                        {a.bio}
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {/* Metadata */}
          <section>
            <SectionLabel>Logistics</SectionLabel>
            <dl className="grid grid-cols-[100px_1fr] gap-y-1.5 gap-x-3 text-[13px] m-0">
              {meeting.location && (
                <>
                  <dt className="text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--color-muted)] pt-0.5">
                    Location
                  </dt>
                  {/* v0.4.57: clickable location with pin icon, opens
                      Google Maps in a new tab. No API key needed; uses
                      the public maps.google.com search URL. */}
                  <dd className="m-0 text-[var(--color-ink)]">
                    <a
                      href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(meeting.location)}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-start gap-1.5 text-[var(--color-ink)] hover:text-[var(--color-accent)] hover:underline group"
                      title="Open in Google Maps"
                    >
                      <svg
                        width="14"
                        height="14"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        className="shrink-0 mt-[3px] text-[var(--color-accent)]"
                      >
                        <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" />
                        <circle cx="12" cy="10" r="3" />
                      </svg>
                      <span>{meeting.location}</span>
                    </a>
                  </dd>
                </>
              )}
              {meeting.conferenceLink && (
                <>
                  <dt className="text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--color-muted)] pt-0.5">
                    Conference
                  </dt>
                  <dd className="m-0 break-all">
                    <a
                      href={meeting.conferenceLink}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-[var(--color-accent)] hover:underline"
                    >
                      {meeting.conferenceLink}
                    </a>
                  </dd>
                </>
              )}
              <dt className="text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--color-muted)] pt-0.5">
                Source
              </dt>
              <dd className="m-0 font-mono text-[11px] text-[var(--color-muted)] break-all">
                {meeting.googleEventId}
              </dd>
            </dl>
          </section>
        </div>
      )}
    </Drawer>
  );
}

function BriefSkeleton({
  generating,
  phase,
}: {
  generating: boolean;
  phase: number;
}) {
  // v0.4.48 — two visual variants share the same pulse skeleton, only
  // the footer differs.
  //
  //   generating = true  → explicit fetch in flight (UI Refresh /
  //                         future-meeting auto-trigger). Spinner +
  //                         cycling phase label.
  //   generating = false → passive wait. The Day Brief run will land
  //                         this brief shortly. Single calm label, no
  //                         spinner.
  return (
    <div className="rounded-md border border-[var(--color-rule)] overflow-hidden">
      {/* Pulsing skeleton lines */}
      <div className="px-3 pt-3 pb-8 space-y-2.5 animate-pulse">
        <div className="h-2.5 rounded-full bg-[var(--color-rule)] w-full" />
        <div className="h-2.5 rounded-full bg-[var(--color-rule)] w-[91%]" />
        <div className="h-2.5 rounded-full bg-[var(--color-rule)] w-[78%]" />
        <div className="h-2.5 rounded-full bg-[var(--color-rule)] w-[95%]" />
        <div className="h-2.5 rounded-full bg-[var(--color-rule)] w-[62%]" />
      </div>
      {/* Status footer */}
      <div className="border-t border-[var(--color-rule)] px-3 py-2 flex items-center gap-2 bg-[var(--color-paper)]">
        {generating && <SpinnerIcon />}
        <span
          key={generating ? phase : "pending"}
          className="text-[11px] text-[var(--color-muted)] italic transition-opacity duration-300"
        >
          {generating
            ? `${BRIEF_PHASES[phase]}…`
            : "Composing your prep. It will land here shortly."}
        </span>
      </div>
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

function CategorizeSection({
  meetingId,
  currentKind,
  kindLocked,
}: {
  meetingId: string;
  currentKind: EditableKind;
  kindLocked: boolean;
}) {
  const queryClient = useQueryClient();
  // Optimistic local state — flips immediately on click, snaps back on
  // server error. The hook refetch will reconcile when it lands.
  const [optimistic, setOptimistic] = useState<EditableKind | null>(null);
  const [pendingKind, setPendingKind] = useState<EditableKind | null>(null);
  const shown = optimistic ?? currentKind;

  async function setKind(next: EditableKind) {
    if (next === shown) return;
    setOptimistic(next);
    setPendingKind(next);
    try {
      await callTool<
        { meetingId: string; kind: EditableKind },
        { data: unknown }
      >("executive-assistant.meetings.set_kind", {
        meetingId,
        kind: next,
      });
      // Single partial-match invalidation catches the per-id fetch
      // (useMeeting), the today list, and any per-date list — all
      // their keys start with ["ea", "meetings"].
      await queryClient.invalidateQueries({ queryKey: ["ea", "meetings"] });
    } catch {
      setOptimistic(null);
    } finally {
      setPendingKind(null);
    }
  }

  return (
    <section>
      <div className="flex items-baseline justify-between mb-2">
        <SectionLabel>Categorize</SectionLabel>
        {kindLocked && (
          <span className="text-[11px] text-[var(--color-muted)] italic">
            Locked to your choice
          </span>
        )}
      </div>
      <div className="flex flex-wrap gap-1.5">
        {EDITABLE_KINDS.map((k) => {
          const isActive = shown === k;
          const isPending = pendingKind === k;
          return (
            <button
              key={k}
              type="button"
              onClick={() => setKind(k)}
              disabled={isPending}
              className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border text-[12.5px] font-medium transition-colors cursor-pointer ${
                isActive
                  ? "border-[var(--color-accent)] bg-[var(--color-accent-tint)] text-[var(--color-ink)]"
                  : "border-[var(--color-rule)] bg-[var(--color-surface)] text-[var(--color-ink-soft)] hover:bg-[var(--color-paper-warm)]"
              } disabled:opacity-60`}
            >
              <KindChip kind={k as ItemKindUi} size="compact" />
              {isPending && (
                <span className="text-[10.5px] text-[var(--color-muted)]">…</span>
              )}
            </button>
          );
        })}
      </div>
      <div className="text-[11.5px] text-[var(--color-muted)] mt-2">
        How the agent thinks about this on /executive. Your choice sticks
        and the classifier won't overwrite it.
      </div>
    </section>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--color-muted)] mb-2">
      {children}
    </div>
  );
}

function meetingSubtitle(m: {
  startsAt: string;
  endsAt: string;
  organizerEmail: string | null;
}): string {
  const start = new Date(m.startsAt);
  const end = new Date(m.endsAt);
  const fmtTime = (d: Date) =>
    d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
  const fmtDate = start.toLocaleDateString([], {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
  const range = `${fmtDate} · ${fmtTime(start)}–${fmtTime(end)}`;
  return m.organizerEmail ? `${range} · ${m.organizerEmail}` : range;
}
