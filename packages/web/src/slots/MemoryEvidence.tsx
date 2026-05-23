// /executive/memory — feedback signals stream + future memory tag
// display. Shell-native styling.
//
// Today it shows the live feedback signal feed — what the agent will
// reflect on weekly. v0.5+: surface contextual memory tags themselves
// once memory.recall is exposed to the UI layer.

import { useFeedbackSignals, type FeedbackSignal } from "../hooks/useDossier.js";
import { EmptyState } from "../components/EmptyState.js";
import { LoadingState } from "../components/LoadingState.js";
import { formatRelativeAgo } from "../lib/format.js";

export function MemoryEvidence() {
  const q = useFeedbackSignals(50);

  return (
    <div className="h-full overflow-y-auto">
      <div className="px-8 pt-8 pb-4 border-b border-[var(--color-rule-soft)]">
        <h1 className="m-0 text-2xl font-semibold leading-tight tracking-[-0.005em] text-[var(--color-ink)] mb-1">
          What the agent has learned
        </h1>
        <div className="text-[13.5px] text-[var(--color-muted)]">
          Memory &amp; evidence trail
        </div>
      </div>

      <div className="px-8 py-6 max-w-[1100px]">
        <p className="text-[var(--color-ink-soft)] text-[14.5px] max-w-[680px] leading-[1.55] mb-6">
          Contextual memories accumulated by the agent live in BoringOS's
          memory store. The weekly reflection routine reads the feedback
          stream below and updates the relevant tags. The memories themselves
          will surface on this page once they've been written.
        </p>

        <section className="mb-8">
          <div className="text-[11px] font-semibold tracking-[0.06em] uppercase text-[var(--color-muted)] mb-3">
            Recent feedback · what the agent will reflect on
          </div>

          {q.isLoading && <LoadingState label="Reading the signal stream…" />}
          {q.data && q.data.data.length === 0 && (
            <EmptyState
              title="No feedback signals yet"
              description="Edit a meeting brief, resolve a conflict, or dismiss an action item — the trail starts there. The agent reads this stream weekly to refine its read of you."
            />
          )}
          {q.data && q.data.data.length > 0 && (
            <FeedbackStream rows={q.data.data} />
          )}
        </section>
      </div>
    </div>
  );
}

function FeedbackStream({ rows }: { rows: FeedbackSignal[] }) {
  return (
    <div className="bg-[var(--color-surface)] border border-[var(--color-rule)] rounded-[10px] overflow-hidden">
      <table className="w-full border-collapse text-[13.5px]">
        <thead>
          <tr>
            <Th>When</Th>
            <Th>Kind</Th>
            <Th>Subject</Th>
            <Th>Detail</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr
              key={r.id}
              className="border-b border-[var(--color-rule-soft)] last:border-b-0 hover:bg-[var(--color-paper-warm)] transition-colors"
            >
              <Td>
                <span className="font-mono text-[11.5px] text-[var(--color-muted)] whitespace-nowrap">
                  {formatRelativeAgo(r.createdAt)}
                </span>
              </Td>
              <Td>
                <span className="font-mono text-[11.5px] text-[var(--color-accent)] whitespace-nowrap">
                  {r.signalKind}
                </span>
              </Td>
              <Td>
                <span className="text-[12px] text-[var(--color-muted)]">
                  {r.subjectKind} · {r.subjectId.slice(0, 8)}…
                </span>
              </Td>
              <Td>
                <span className="text-[var(--color-ink-soft)] text-[13px]">
                  {describeValue(r)}
                </span>
              </Td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th className="text-left bg-[var(--color-paper-warm)] text-[11px] font-semibold tracking-[0.06em] uppercase text-[var(--color-muted)] px-3.5 py-2.5 border-b border-[var(--color-rule-soft)]">
      {children}
    </th>
  );
}

function Td({ children }: { children: React.ReactNode }) {
  return <td className="text-left align-top px-3.5 py-2.5">{children}</td>;
}

function describeValue(r: FeedbackSignal): string {
  const v = r.value;
  switch (r.signalKind) {
    case "edited_brief":
      return typeof v.summary === "string" ? v.summary : "brief edited";
    case "conflict_resolved":
      return typeof v.overlapMinutes === "number"
        ? `chose one of two · ${v.overlapMinutes} min overlap`
        : "conflict resolved";
    case "dismissed_action":
      return typeof v.text === "string" ? `"${v.text}"` : "action dismissed";
    case "marked_unhelpful":
      return typeof v.deltaKind === "string" ? `less of ${v.deltaKind}` : "less of this";
    default:
      return "";
  }
}
