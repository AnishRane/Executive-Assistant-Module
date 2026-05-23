// /executive/history — past snapshots, shell-native styling.
// Simple chronological list; v0.5+ might add a calendar grid picker.

import { Link } from "react-router-dom";
import { useSnapshotHistory } from "../hooks/useDossier.js";
import { EmptyState } from "../components/EmptyState.js";
import { LoadingState } from "../components/LoadingState.js";
import { formatDateLong } from "../lib/format.js";

export function SnapshotHistory() {
  const q = useSnapshotHistory(90);

  return (
    <div className="h-full overflow-y-auto">
      <div className="px-8 pt-8 pb-4 border-b border-[var(--color-rule-soft)]">
        <h1 className="m-0 text-2xl font-semibold leading-tight tracking-[-0.005em] text-[var(--color-ink)] mb-1">
          Past dossiers
        </h1>
        <div className="text-[13.5px] text-[var(--color-muted)]">
          {q.isLoading
            ? "Last 90 days"
            : `Last 90 days · ${q.data?.data.length ?? 0} composed`}
        </div>
      </div>

      <div className="px-8 py-6 max-w-[1100px]">
        {q.isLoading && <LoadingState label="Loading past dossiers…" />}
        {q.data && q.data.data.length === 0 && (
          <EmptyState
            title="No past dossiers yet"
            description="Composed mornings appear here. The first one lands after the next compose tick — every 15 minutes during the day, or right at 06:00 tomorrow."
          />
        )}
        {q.data && q.data.data.length > 0 && (
          <div className="bg-[var(--color-surface)] border border-[var(--color-rule)] rounded-[12px] overflow-hidden">
            {q.data.data.map((s) => (
              <Link
                key={s.id}
                to={`/executive?date=${s.snapshotDate}`}
                className="block px-[18px] py-3.5 border-b border-[var(--color-rule-soft)] last:border-b-0 hover:bg-[var(--color-paper-warm)] transition-colors"
              >
                <div className="text-[11px] font-semibold tracking-[0.06em] uppercase text-[var(--color-muted)]">
                  {formatDateLong(s.snapshotDate)}
                </div>
                {s.narrativeBrief && (
                  <div className="text-[var(--color-ink-soft)] text-[14px] mt-1 line-clamp-2">
                    {s.narrativeBrief}
                  </div>
                )}
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
