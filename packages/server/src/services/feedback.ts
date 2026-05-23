// Internal helper for writing feedback_signals rows. Used by both
// the generic feedback_signals.record tool and the domain tools
// that wrap-and-record (action_items.dismiss, conflicts.resolve, etc.).
//
// Tries to be a best-effort no-throw: a feedback write failure should
// never roll back the parent domain operation.

import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { feedbackSignals } from "../schema/feedback_signals.js";

export type SignalKind =
  | "edited_brief"
  | "edited_attendee_bio"
  | "pinned_thread"
  | "dismissed_action"
  | "marked_unhelpful"
  | "conflict_resolved"
  | "conflict_both_skipped"
  | "edited_notes"
  | "opened_card"
  | "acknowledged_delta"
  | "dismissed_suggestion"
  | "weather_dismissed"
  | "weather_too_detailed"
  | "weather_too_terse";

export type SubjectKind =
  | "meeting"
  | "trip_leg"
  | "snapshot"
  | "delta"
  | "action_item"
  | "conflict"
  | "attendee"
  | "weather";

export interface FeedbackWrite {
  tenantId: string;
  signalKind: SignalKind;
  subjectKind: SubjectKind;
  subjectId: string;
  value?: Record<string, unknown>;
  createdByUserId?: string | null;
}

export async function writeFeedback(
  db: PostgresJsDatabase,
  w: FeedbackWrite,
): Promise<void> {
  try {
    await db.insert(feedbackSignals).values({
      tenantId: w.tenantId,
      signalKind: w.signalKind,
      subjectKind: w.subjectKind,
      subjectId: w.subjectId,
      value: w.value ?? {},
      createdByUserId: w.createdByUserId ?? null,
    });
  } catch (err) {
    console.warn(
      `[writeFeedback] failed for ${w.signalKind} on ${w.subjectKind}:${w.subjectId}:`,
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * Cheap text diff summary for `edited_brief` payloads. We store the
 * actual before/after; this helper produces a short human-readable
 * signature ("−2 sentences, −15 words") for legible logging.
 */
export function summariseDiff(
  before: string,
  after: string,
): { wordsDelta: number; sentencesDelta: number; summary: string } {
  const wordsBefore = before.trim().split(/\s+/).filter(Boolean).length;
  const wordsAfter = after.trim().split(/\s+/).filter(Boolean).length;
  const sentencesBefore = before.split(/[.!?]+/).filter((s) => s.trim()).length;
  const sentencesAfter = after.split(/[.!?]+/).filter((s) => s.trim()).length;
  const wordsDelta = wordsAfter - wordsBefore;
  const sentencesDelta = sentencesAfter - sentencesBefore;
  const parts: string[] = [];
  if (wordsDelta !== 0) parts.push(`${wordsDelta > 0 ? "+" : ""}${wordsDelta} words`);
  if (sentencesDelta !== 0)
    parts.push(`${sentencesDelta > 0 ? "+" : ""}${sentencesDelta} sentences`);
  return {
    wordsDelta,
    sentencesDelta,
    summary: parts.length > 0 ? parts.join(", ") : "minor edit",
  };
}
