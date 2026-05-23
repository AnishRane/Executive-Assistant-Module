// Pure rule-based classifier for calendar item kind.
//
// Rule order (first match wins):
//   1. conferenceLink present                                       → meeting (high)
//   2. title matches meeting keyword                                → meeting (high)
//   3. title starts with imperative verb AND no external attendees  → task    (high)
//   4. has external attendees                                       → event   (high)
//   5. otherwise                                                    → untagged (low)
//
// See docs/categorization-design.md § Phase 1 for the locked rule set.

import { describe, it, expect } from "vitest";
import { classify } from "../src/services/classify.js";

describe("classify", () => {
  it("Rule 1 — video link present → meeting (high)", () => {
    expect(
      classify({
        title: "Q3 review",
        conferenceLink: "https://zoom.us/j/8472",
        location: null,
        hasExternalAttendees: true,
      }),
    ).toEqual({ kind: "meeting", confidence: "high" });
  });

  it("Rule 2 — meeting keyword in title → meeting (high)", () => {
    expect(
      classify({
        title: "Catchup with Rohit",
        conferenceLink: null,
        location: null,
        hasExternalAttendees: true,
      }),
    ).toEqual({ kind: "meeting", confidence: "high" });
  });

  it("Rule 2 — keyword '1:1' (with punctuation) → meeting", () => {
    expect(
      classify({
        title: "Sarah 1:1",
        conferenceLink: null,
        location: null,
        hasExternalAttendees: true,
      }),
    ).toEqual({ kind: "meeting", confidence: "high" });
  });

  it("Rule 3 — imperative verb + solo → task (high)", () => {
    expect(
      classify({
        title: "Review Series B docs",
        conferenceLink: null,
        location: null,
        hasExternalAttendees: false,
      }),
    ).toEqual({ kind: "task", confidence: "high" });
  });

  it("Rule 3 — two-word imperative 'Pick up' → task", () => {
    expect(
      classify({
        title: "Pick up dry cleaning",
        conferenceLink: null,
        location: "415 Grove St",
        hasExternalAttendees: false,
      }),
    ).toEqual({ kind: "task", confidence: "high" });
  });

  it("Rule 3 negative — imperative verb but has attendees → event (rule 4)", () => {
    // "Review with the board" starts with imperative "Review" but has attendees;
    // rule 3 requires solo, so this falls through to rule 4.
    expect(
      classify({
        title: "Review with the board",
        conferenceLink: null,
        location: null,
        hasExternalAttendees: true,
      }),
    ).toEqual({ kind: "event", confidence: "high" });
  });

  it("Rule 4 — has attendees, nothing else fires → event (high)", () => {
    expect(
      classify({
        title: "Lunch with Sarah",
        conferenceLink: null,
        location: "Quince",
        hasExternalAttendees: true,
      }),
    ).toEqual({ kind: "event", confidence: "high" });
  });

  it("Rule 5 — nothing fires → untagged (low)", () => {
    expect(
      classify({
        title: "Dentist",
        conferenceLink: null,
        location: "425 California St",
        hasExternalAttendees: false,
      }),
    ).toEqual({ kind: "untagged", confidence: "low" });
  });

  it("Rule 5 — noun phrase, no attendees → untagged", () => {
    expect(
      classify({
        title: "Maya's recital",
        conferenceLink: null,
        location: "Davies Symphony Hall",
        hasExternalAttendees: false,
      }),
    ).toEqual({ kind: "untagged", confidence: "low" });
  });

  it("precedence — video link wins over imperative title", () => {
    // "Review docs with Rohit" has imperative start AND attendees AND link.
    // Link wins (rule 1).
    expect(
      classify({
        title: "Review docs with Rohit",
        conferenceLink: "https://meet.google.com/abc",
        location: null,
        hasExternalAttendees: true,
      }),
    ).toEqual({ kind: "meeting", confidence: "high" });
  });

  // v0.4.32 — temporal adjectives ('daily', 'weekly', 'monthly') no
  // longer count as meeting keywords. Personal-life items with those
  // titles should fall through to untagged (LLM tagger decides).
  it("Rule 2 negative — 'Daily walk' (solo, no link) → untagged, not meeting", () => {
    expect(
      classify({
        title: "Daily walk",
        conferenceLink: null,
        location: null,
        hasExternalAttendees: false,
      }),
    ).toEqual({ kind: "untagged", confidence: "low" });
  });

  it("Rule 2 negative — 'Weekly grocery run' → untagged", () => {
    expect(
      classify({
        title: "Weekly grocery run",
        conferenceLink: null,
        location: "Whole Foods",
        hasExternalAttendees: false,
      }),
    ).toEqual({ kind: "untagged", confidence: "low" });
  });

  it("Rule 2 negative — 'Monthly piano lesson' → untagged", () => {
    expect(
      classify({
        title: "Monthly piano lesson",
        conferenceLink: null,
        location: null,
        hasExternalAttendees: false,
      }),
    ).toEqual({ kind: "untagged", confidence: "low" });
  });

  it("case-insensitive matching for keywords and verbs", () => {
    expect(
      classify({
        title: "CATCHUP with team",
        conferenceLink: null,
        location: null,
        hasExternalAttendees: true,
      }),
    ).toEqual({ kind: "meeting", confidence: "high" });

    expect(
      classify({
        title: "pick up groceries",
        conferenceLink: null,
        location: null,
        hasExternalAttendees: false,
      }),
    ).toEqual({ kind: "task", confidence: "high" });
  });
});
