// Pure rule-based classifier for calendar item kind.
//
// Rule order (first match wins):
//   1. conferenceLink present                                       → meeting (high)
//   2. title matches a meeting keyword                              → meeting (high)
//   3. title starts with an imperative verb AND no external attendees → task (high)
//   4. has external attendees                                       → event   (high)
//   5. otherwise                                                    → untagged (low)
//
// Spec: docs/categorization-design.md § Phase 1.

export type ItemKind = "meeting" | "event" | "task" | "untagged";

export interface ClassifyInput {
  title: string;
  conferenceLink: string | null;
  location: string | null;
  hasExternalAttendees: boolean;
}

export interface ClassifyResult {
  kind: ItemKind;
  confidence: "high" | "low";
}

// v0.4.32 — removed "weekly", "daily", "monthly". They're temporal
// scheduling adjectives, not meeting markers. "Daily walk" / "Weekly
// grocery run" / "Monthly check-in" (with self) were getting locked
// into kind='meeting' permanently. Let the LLM tagger decide on
// ambiguous personal-titled items.
const MEETING_KEYWORDS = [
  "catchup",
  "catch-up",
  "catch up",
  "sync",
  "1:1",
  "1on1",
  "one-on-one",
  "standup",
  "stand-up",
  "stand up",
  "meeting",
  "kickoff",
  "kick-off",
  "kick off",
  "retro",
  "check-in",
  "check in",
  "checkin",
  "huddle",
  "demo",
  "chat",
];

const IMPERATIVE_VERBS = [
  "pick up",
  "drop off",
  "sign",
  "review",
  "buy",
  "call",
  "send",
  "get",
  "schedule",
  "prepare",
  "draft",
  "write",
  "read",
  "order",
  "renew",
  "pay",
  "file",
  "submit",
  "check",
];

function titleContainsKeyword(title: string, keywords: string[]): boolean {
  const t = title.toLowerCase();
  for (const kw of keywords) {
    // Word-boundary-ish match: avoid matching "synchronize" when looking for "sync"
    // by requiring the keyword to be flanked by non-letter chars (or string edges).
    const pattern = new RegExp(
      `(^|[^a-z0-9])${escapeRegex(kw)}([^a-z0-9]|$)`,
      "i",
    );
    if (pattern.test(t)) return true;
  }
  return false;
}

function titleStartsWithVerb(title: string, verbs: string[]): boolean {
  const t = title.toLowerCase().trim();
  for (const verb of verbs) {
    if (t === verb) return true;
    if (t.startsWith(verb + " ")) return true;
  }
  return false;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function classify(input: ClassifyInput): ClassifyResult {
  // Rule 1 — video link present
  if (input.conferenceLink && input.conferenceLink.trim() !== "") {
    return { kind: "meeting", confidence: "high" };
  }

  // Rule 2 — meeting keyword
  if (titleContainsKeyword(input.title, MEETING_KEYWORDS)) {
    return { kind: "meeting", confidence: "high" };
  }

  // Rule 3 — imperative verb + solo
  if (
    !input.hasExternalAttendees &&
    titleStartsWithVerb(input.title, IMPERATIVE_VERBS)
  ) {
    return { kind: "task", confidence: "high" };
  }

  // Rule 4 — has external attendees
  if (input.hasExternalAttendees) {
    return { kind: "event", confidence: "high" };
  }

  // Rule 5 — nothing fires
  return { kind: "untagged", confidence: "low" };
}
