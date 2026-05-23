// Tests for the v0.4.14 conflict scan. Pure overlap math + the
// per-date recompute. Scan reads meetings / ooo / trip_legs directly
// for a date; no snapshot or timeline_item involvement.

import { describe, it, expect } from "vitest";
import { findOverlapPairs, type ScanItem } from "../src/services/conflict_scan.js";

function item(id: string, kind: ScanItem["kind"], start: string, end: string): ScanItem {
  return {
    id,
    kind,
    startsAt: new Date(start),
    endsAt: new Date(end),
  };
}

describe("findOverlapPairs", () => {
  it("returns no pairs when no items overlap", () => {
    const items = [
      item("a", "meeting", "2026-05-16T09:00:00Z", "2026-05-16T10:00:00Z"),
      item("b", "meeting", "2026-05-16T11:00:00Z", "2026-05-16T12:00:00Z"),
    ];
    expect(findOverlapPairs(items)).toEqual([]);
  });

  it("returns one pair when two items overlap by 30 minutes", () => {
    const items = [
      item("aaaa", "meeting", "2026-05-16T10:00:00Z", "2026-05-16T11:00:00Z"),
      item("bbbb", "meeting", "2026-05-16T10:30:00Z", "2026-05-16T11:30:00Z"),
    ];
    const pairs = findOverlapPairs(items);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]).toMatchObject({
      aId: "aaaa",
      aKind: "meeting",
      bId: "bbbb",
      bKind: "meeting",
      overlapMinutes: 30,
    });
  });

  it("canonicalises pair order: lexicographically smaller id is `a`", () => {
    const items = [
      item("zzz", "meeting", "2026-05-16T10:00:00Z", "2026-05-16T11:00:00Z"),
      item("aaa", "meeting", "2026-05-16T10:30:00Z", "2026-05-16T11:30:00Z"),
    ];
    const pairs = findOverlapPairs(items);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]!.aId).toBe("aaa");
    expect(pairs[0]!.bId).toBe("zzz");
  });

  it("skips items missing an endsAt — can't compute overlap without one", () => {
    const items = [
      { id: "a", kind: "meeting" as const, startsAt: new Date("2026-05-16T10:00:00Z"), endsAt: null },
      item("b", "meeting", "2026-05-16T10:30:00Z", "2026-05-16T11:30:00Z"),
    ];
    expect(findOverlapPairs(items)).toEqual([]);
  });

  it("treats touching intervals as NON-overlapping (10:00-11:00 vs 11:00-12:00)", () => {
    const items = [
      item("aaa", "meeting", "2026-05-16T10:00:00Z", "2026-05-16T11:00:00Z"),
      item("bbb", "meeting", "2026-05-16T11:00:00Z", "2026-05-16T12:00:00Z"),
    ];
    expect(findOverlapPairs(items)).toEqual([]);
  });

  it("detects cross-kind overlaps (meeting × ooo)", () => {
    const items = [
      item("mmm", "meeting", "2026-05-16T10:00:00Z", "2026-05-16T11:00:00Z"),
      item("ooo", "ooo", "2026-05-16T08:00:00Z", "2026-05-16T18:00:00Z"),
    ];
    const pairs = findOverlapPairs(items);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]!.overlapMinutes).toBe(60);
  });

  it("returns one pair per overlapping combination across N items", () => {
    const items = [
      item("aaa", "meeting", "2026-05-16T10:00:00Z", "2026-05-16T11:00:00Z"),
      item("bbb", "meeting", "2026-05-16T10:30:00Z", "2026-05-16T11:30:00Z"),
      item("ccc", "meeting", "2026-05-16T10:45:00Z", "2026-05-16T11:15:00Z"),
      item("ddd", "meeting", "2026-05-16T13:00:00Z", "2026-05-16T14:00:00Z"),
    ];
    const pairs = findOverlapPairs(items);
    // aaa-bbb, aaa-ccc, bbb-ccc, but NOT ddd
    expect(pairs).toHaveLength(3);
    const pairIds = pairs.map((p) => `${p.aId}-${p.bId}`).sort();
    expect(pairIds).toEqual(["aaa-bbb", "aaa-ccc", "bbb-ccc"]);
  });
});
