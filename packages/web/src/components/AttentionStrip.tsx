// AttentionStrip — collapsible "things to look at" strip with full
// resolve flow inlined into the same component.
//
// State machine:
//
//   IDLE          thin strip · "N things to look at · Resolve →"
//      │ click Resolve
//      ▼
//   EXPANDED      panel · one row per unacknowledged delta + unresolved conflict
//      │
//      ├─ click Got it on a delta  → call deltas.acknowledge, row collapses to "acknowledged + Undo"
//      ├─ click Resolve → on a conflict → row expands to pick cards (FOCUSED state)
//      └─ click X      → back to IDLE
//
//   FOCUSED       conflict row expanded with two pick cards
//      │
//      ├─ click a pick card → highlight
//      ├─ click Apply choice only → call conflicts.resolve, collapse row to "acknowledged"
//      ├─ click Cancel → back to EXPANDED with no choice made
//      └─ (future: Apply + save draft, Apply + send + reschedule — Phase C+)
//
// All transitions stay inline; nothing navigates, nothing modal-overlays.
// Component owns its own state; Today.tsx just supplies data + invalidate callbacks.

import { useState, useMemo } from "react";
import type { Delta, Conflict } from "../hooks/useDossier.js";

/** Shape of a timeline item EA can resolve a conflict against. */
export interface ConflictItemRef {
  /** entity id (meeting / ooo / trip_leg) — passed to conflicts.resolve as chosenRefId. */
  timelineItemId: string;
  /** Display title for the pick card. */
  title: string;
  /** Optional secondary line. */
  sub?: string;
}

interface AttentionStripProps {
  deltas: Delta[];
  conflicts: Conflict[];
  /** timeline_item_id → display info. Used to render conflict pick cards. */
  conflictItemRefs: Map<string, ConflictItemRef>;
  /**
   * Set of conflict ids where BOTH referenced entities have already
   * ended (in the past). UI shifts copy to retro-capture mode:
   * "Which did you actually attend?" + adds the "Neither" button.
   */
  expiredConflictIds: Set<string>;
  /** Async — actually calls deltas.acknowledge under the hood. */
  onAcknowledgeDelta: (deltaId: string) => Promise<void>;
  /** Async — actually calls conflicts.resolve with chosenRefId under the hood. */
  onResolveConflict: (conflictId: string, chosenItemId: string) => Promise<void>;
  /**
   * Called when the user reports they attended neither side of a
   * conflict (only offered when conflict is expired). Translates to
   * conflicts.resolve with no chosenRefId on the server.
   */
  onResolveConflictAsBothSkipped: (conflictId: string) => Promise<void>;
}

type LocalState =
  | { kind: "idle" }
  | { kind: "expanded" }
  | { kind: "focused"; conflictId: string; chosenItemId: string | null };

export function AttentionStrip({
  deltas,
  conflicts,
  conflictItemRefs,
  expiredConflictIds,
  onAcknowledgeDelta,
  onResolveConflict,
  onResolveConflictAsBothSkipped,
}: AttentionStripProps) {
  const [state, setState] = useState<LocalState>({ kind: "idle" });
  // Optimistically-acknowledged ids so the row collapses instantly even
  // before the query invalidation refetches. Cleared when invalidation
  // returns the row missing.
  const [optimisticallyAcked, setOptimisticallyAcked] = useState<Set<string>>(new Set());
  const [optimisticallyResolved, setOptimisticallyResolved] = useState<Set<string>>(new Set());

  const visibleDeltas = useMemo(
    () => deltas.filter((d) => !d.acknowledgedAt && !optimisticallyAcked.has(d.id)),
    [deltas, optimisticallyAcked],
  );
  const visibleConflicts = useMemo(
    () =>
      conflicts.filter(
        (c) =>
          (c.resolutionStatus === "unresolved" || c.resolutionStatus === "acknowledged") &&
          !optimisticallyResolved.has(c.id),
      ),
    [conflicts, optimisticallyResolved],
  );

  // Track resolved/acked counts for the panel header progress line
  const resolvedDeltaCount = deltas.filter(
    (d) => d.acknowledgedAt || optimisticallyAcked.has(d.id),
  ).length;
  const resolvedConflictCount = conflicts.filter(
    (c) =>
      c.resolutionStatus === "resolved_by_user" ||
      c.resolutionStatus === "auto_resolved" ||
      optimisticallyResolved.has(c.id),
  ).length;
  const totalIssues = deltas.length + conflicts.length;
  const totalResolved = resolvedDeltaCount + resolvedConflictCount;
  const totalRemaining = visibleDeltas.length + visibleConflicts.length;

  // ── If nothing actionable, render nothing. ──
  if (totalIssues === 0) return null;

  // ── If everything resolved (locally), show the "all clear" strip ──
  if (totalRemaining === 0 && totalIssues > 0) {
    return (
      <div className="flex items-center gap-3 bg-[var(--color-green-soft)] border border-[var(--color-green)] rounded-md px-4 py-2.5 mb-4 text-sm text-[var(--color-green)]">
        <span className="text-[14px] leading-none">✓</span>
        <span>
          <strong className="font-semibold">All clear</strong>
          <span className="text-[var(--color-muted)]">
            {" "}· {totalIssues} item{totalIssues === 1 ? "" : "s"} handled
          </span>
        </span>
      </div>
    );
  }

  // ── IDLE state ──
  if (state.kind === "idle") {
    return (
      <div className="flex items-center gap-3.5 bg-[var(--color-surface)] border border-[var(--color-rule)] border-l-[3px] border-l-[var(--color-accent)] rounded-md px-4 py-3 mb-4">
        <span className="text-[14px] text-[var(--color-accent)] leading-none">👁</span>
        <span className="text-sm text-[var(--color-ink)]">
          <strong className="font-semibold">
            {totalRemaining} thing{totalRemaining === 1 ? "" : "s"} to look at
          </strong>
          <span className="text-[var(--color-muted)]">
            {" "}· {summarizeIssues(visibleDeltas.length, visibleConflicts.length)}
          </span>
        </span>
        <button
          type="button"
          onClick={() => setState({ kind: "expanded" })}
          className="ml-auto bg-[var(--color-accent-tint)] border border-[var(--color-accent)] text-[var(--color-accent)] text-[12px] font-medium rounded-md px-3 py-1 hover:bg-[var(--color-accent)] hover:text-white transition-colors cursor-pointer"
        >
          Resolve →
        </button>
      </div>
    );
  }

  // ── EXPANDED / FOCUSED state ──
  return (
    <div className="bg-[var(--color-surface)] border border-[var(--color-accent)] border-l-[3px] border-l-[var(--color-accent)] rounded-md px-5 py-4 mb-4">
      <div className="flex items-baseline justify-between mb-3 pb-2.5 border-b border-[var(--color-rule-soft)]">
        <h3 className="m-0 text-sm font-semibold text-[var(--color-ink)]">
          {totalRemaining} thing{totalRemaining === 1 ? "" : "s"} to look at
        </h3>
        <span className="font-mono text-[11px] text-[var(--color-muted)]">
          {totalResolved} of {totalIssues} resolved
        </span>
        <button
          type="button"
          onClick={() => setState({ kind: "idle" })}
          aria-label="Collapse"
          className="bg-transparent border-0 text-[var(--color-muted)] hover:text-[var(--color-ink)] cursor-pointer text-sm px-1 ml-2"
        >
          ×
        </button>
      </div>

      {/* Delta rows (always shown collapsed once acked, but in this phase
          we hide them via optimistic acked + query invalidation.) */}
      {visibleDeltas.map((d) => (
        <DeltaRow
          key={d.id}
          delta={d}
          onAck={async () => {
            setOptimisticallyAcked((s) => new Set(s).add(d.id));
            try {
              await onAcknowledgeDelta(d.id);
            } catch {
              // Roll back on failure
              setOptimisticallyAcked((s) => {
                const next = new Set(s);
                next.delete(d.id);
                return next;
              });
            }
          }}
        />
      ))}

      {/* Conflict rows */}
      {visibleConflicts.map((c) => {
        // v0.4.14: conflicts reference entity ids directly via refAId / refBId.
        const itemA = conflictItemRefs.get(c.refAId);
        const itemB = conflictItemRefs.get(c.refBId);
        const isFocused = state.kind === "focused" && state.conflictId === c.id;
        const expired = expiredConflictIds.has(c.id);
        return (
          <ConflictRow
            key={c.id}
            conflict={c}
            itemA={itemA}
            itemB={itemB}
            focused={isFocused}
            expired={expired}
            chosenItemId={isFocused ? state.chosenItemId : null}
            onOpen={() => setState({ kind: "focused", conflictId: c.id, chosenItemId: null })}
            onCancel={() => setState({ kind: "expanded" })}
            onPick={(id) => setState({ kind: "focused", conflictId: c.id, chosenItemId: id })}
            onApply={async (chosen) => {
              setOptimisticallyResolved((s) => new Set(s).add(c.id));
              setState({ kind: "expanded" });
              try {
                await onResolveConflict(c.id, chosen);
              } catch {
                setOptimisticallyResolved((s) => {
                  const next = new Set(s);
                  next.delete(c.id);
                  return next;
                });
              }
            }}
            onApplyNeither={async () => {
              setOptimisticallyResolved((s) => new Set(s).add(c.id));
              setState({ kind: "expanded" });
              try {
                await onResolveConflictAsBothSkipped(c.id);
              } catch {
                setOptimisticallyResolved((s) => {
                  const next = new Set(s);
                  next.delete(c.id);
                  return next;
                });
              }
            }}
          />
        );
      })}
    </div>
  );
}

// ─── Helpers + sub-components ───────────────────────────────────

function summarizeIssues(deltas: number, conflicts: number): string {
  const parts: string[] = [];
  if (deltas > 0) parts.push(`${deltas} change${deltas === 1 ? "" : "s"}`);
  if (conflicts > 0)
    parts.push(`${conflicts} conflict${conflicts === 1 ? "" : "s"}`);
  return parts.join(" · ");
}

function DeltaRow({
  delta,
  onAck,
}: {
  delta: Delta;
  onAck: () => Promise<void>;
}) {
  const [acking, setAcking] = useState(false);
  const time = new Date(delta.occurredAt).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  return (
    <div className="grid grid-cols-[24px_1fr_auto] gap-3.5 items-start py-3.5 border-t border-[var(--color-rule-soft)] first:border-t-0 first:pt-1">
      <div className="w-6 h-6 rounded-full bg-[var(--color-amber-soft)] text-[var(--color-accent)] grid place-items-center text-[13px] font-semibold">
        ↑
      </div>
      <div>
        <div className="flex items-baseline gap-2 flex-wrap mb-0.5">
          <span className="text-[11px] font-semibold tracking-[0.06em] uppercase text-[var(--color-accent)]">
            Change
          </span>
          <span className="font-mono text-[12px] text-[var(--color-muted)]">{time}</span>
        </div>
        <div className="text-[14.5px] text-[var(--color-ink)] my-1">
          {delta.summary ?? "Something changed since the morning snapshot."}
        </div>
      </div>
      <div>
        <button
          type="button"
          disabled={acking}
          onClick={async () => {
            setAcking(true);
            await onAck();
            setAcking(false);
          }}
          className="bg-[var(--color-accent)] text-white border border-[var(--color-accent)] text-[12.5px] font-medium rounded-md px-2.5 py-1 hover:bg-[#a04a08] transition-colors cursor-pointer disabled:opacity-50"
        >
          Got it
        </button>
      </div>
    </div>
  );
}

function ConflictRow({
  conflict,
  itemA,
  itemB,
  focused,
  expired,
  chosenItemId,
  onOpen,
  onCancel,
  onPick,
  onApply,
  onApplyNeither,
}: {
  conflict: Conflict;
  itemA: ConflictItemRef | undefined;
  itemB: ConflictItemRef | undefined;
  focused: boolean;
  expired: boolean;
  chosenItemId: string | null;
  onOpen: () => void;
  onCancel: () => void;
  onPick: (id: string) => void;
  onApply: (chosenItemId: string) => Promise<void>;
  onApplyNeither: () => Promise<void>;
}) {
  const [applying, setApplying] = useState(false);

  // Eyebrow + copy shift when the conflict has already ended. Retro
  // capture is about reporting, not deciding.
  const eyebrow = expired
    ? "Look back · which did you attend?"
    : focused
      ? "Conflict · which to keep?"
      : "Conflict";
  const eyebrowColor = expired ? "var(--color-muted)" : "var(--color-conflict)";
  const heading = expired
    ? "These both happened — which did you actually attend?"
    : "Pick the one you'll attend live.";
  const pickCardEyebrow = expired ? "I attended this" : "Keep this one";
  const applyLabel = expired ? "Save" : "Apply choice";

  if (!focused) {
    return (
      <div className="grid grid-cols-[24px_1fr_auto] gap-3.5 items-start py-3.5 border-t border-[var(--color-rule-soft)] first:border-t-0 first:pt-1">
        <div
          className={[
            "w-6 h-6 rounded-full grid place-items-center text-[13px] font-semibold",
            expired
              ? "bg-[var(--color-paper-warm)] text-[var(--color-muted)]"
              : "bg-[var(--color-red-soft)] text-[var(--color-conflict)]",
          ].join(" ")}
        >
          {expired ? "↺" : "⚠"}
        </div>
        <div>
          <div className="flex items-baseline gap-2 flex-wrap mb-0.5">
            <span
              className="text-[11px] font-semibold tracking-[0.06em] uppercase"
              style={{ color: eyebrowColor }}
            >
              {expired ? "Look back" : "Conflict"}
            </span>
            <span className="font-mono text-[12px] text-[var(--color-muted)]">
              {conflict.overlapMinutes} min overlap
            </span>
          </div>
          <div className="text-[14.5px] text-[var(--color-ink)] my-1">
            {itemA?.title ?? "Item A"} overlaps {itemB?.title ?? "Item B"}
          </div>
        </div>
        <div>
          <button
            type="button"
            onClick={onOpen}
            className="bg-[var(--color-surface)] border border-[var(--color-rule)] text-[var(--color-ink)] text-[12.5px] font-medium rounded-md px-2.5 py-1 hover:bg-[var(--color-paper-warm)] transition-colors cursor-pointer"
          >
            {expired ? "Review →" : "Resolve →"}
          </button>
        </div>
      </div>
    );
  }

  // ── Focused state (pick cards) ──
  return (
    <div className="grid grid-cols-[24px_1fr] gap-3.5 items-start py-4 border-t border-[var(--color-rule-soft)] first:border-t-0 first:pt-1">
      <div
        className={[
          "w-6 h-6 rounded-full grid place-items-center text-[13px] font-semibold",
          expired
            ? "bg-[var(--color-paper-warm)] text-[var(--color-muted)]"
            : "bg-[var(--color-red-soft)] text-[var(--color-conflict)]",
        ].join(" ")}
      >
        {expired ? "↺" : "⚠"}
      </div>
      <div>
        <div className="flex items-baseline gap-2 flex-wrap mb-1">
          <span
            className="text-[11px] font-semibold tracking-[0.06em] uppercase"
            style={{ color: eyebrowColor }}
          >
            {eyebrow}
          </span>
          <span className="font-mono text-[12px] text-[var(--color-muted)]">
            {conflict.overlapMinutes} min overlap
          </span>
        </div>
        <div className="text-[14.5px] text-[var(--color-ink)] mb-2.5">
          {heading}
        </div>

        <div className="grid grid-cols-2 gap-2.5">
          {[itemA, itemB].map((item, idx) => {
            if (!item) return <div key={idx} />;
            const chosen = chosenItemId === item.timelineItemId;
            return (
              <button
                key={item.timelineItemId}
                type="button"
                onClick={() => onPick(item.timelineItemId)}
                className={[
                  "text-left bg-[var(--color-paper)] border rounded-lg px-3.5 py-3 cursor-pointer transition-colors",
                  chosen
                    ? "border-[var(--color-accent)] bg-[var(--color-accent-tint)]"
                    : "border-[var(--color-rule)] hover:bg-[var(--color-paper-warm)] hover:border-[var(--color-accent)]",
                ].join(" ")}
              >
                <div className="text-[10.5px] font-semibold tracking-[0.05em] uppercase text-[var(--color-muted)] mb-1">
                  {pickCardEyebrow}
                </div>
                <div className="text-[13.5px] text-[var(--color-ink)] font-medium">
                  {item.title}
                </div>
                {item.sub && (
                  <div className="text-[12px] text-[var(--color-muted)] mt-0.5">
                    {item.sub}
                  </div>
                )}
              </button>
            );
          })}
        </div>

        <div className="flex gap-2 mt-3.5 flex-wrap">
          <button
            type="button"
            disabled={!chosenItemId || applying}
            onClick={async () => {
              if (!chosenItemId) return;
              setApplying(true);
              await onApply(chosenItemId);
              setApplying(false);
            }}
            className="bg-[var(--color-accent)] text-white border border-[var(--color-accent)] text-[12.5px] font-medium rounded-md px-3 py-1.5 hover:bg-[#a04a08] transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {applyLabel}
          </button>
          {expired && (
            <button
              type="button"
              disabled={applying}
              onClick={async () => {
                setApplying(true);
                await onApplyNeither();
                setApplying(false);
              }}
              className="bg-transparent border border-[var(--color-rule)] text-[var(--color-ink)] text-[12.5px] font-medium px-3 py-1.5 hover:bg-[var(--color-paper-warm)] rounded-md transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Neither — I was caught up elsewhere
            </button>
          )}
          <button
            type="button"
            onClick={onCancel}
            className="bg-transparent border-0 text-[var(--color-muted)] text-[12.5px] font-medium px-3 py-1.5 hover:bg-[var(--color-paper-warm)] hover:text-[var(--color-ink)] rounded-md transition-colors cursor-pointer"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
