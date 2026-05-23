// Tests for the pure day-shape categorizer (services/day_signal.ts).
//
// Inputs: array of local hour numbers (each meeting's local start
// hour). Output: a stable label the LLM can render verbatim.
//
// Rules:
//   - 0 meetings              → "quiet"
//   - all in morning (5–11)   → "morning-heavy"
//   - all in afternoon (12–16)→ "afternoon-heavy"
//   - all in evening (17–20)  → "evening-heavy"
//   - all at night (21–4)     → "after-hours"
//   - 4+ in any 5-hour window → "back-to-back"
//   - otherwise               → "balanced"

import { describe, it, expect } from "vitest";
import { categorizeDayShape } from "../src/services/day_signal.js";

describe("categorizeDayShape", () => {
  it("returns 'quiet' when there are no meetings", () => {
    expect(categorizeDayShape([])).toBe("quiet");
  });

  it("returns 'morning-heavy' when every meeting starts before noon", () => {
    expect(categorizeDayShape([8, 9, 10])).toBe("morning-heavy");
  });

  it("returns 'afternoon-heavy' when every meeting is in 12-16", () => {
    expect(categorizeDayShape([13, 14, 15])).toBe("afternoon-heavy");
  });

  it("returns 'evening-heavy' when every meeting is in 17-20", () => {
    expect(categorizeDayShape([17, 18, 19])).toBe("evening-heavy");
  });

  it("returns 'after-hours' when every meeting is in 21-4", () => {
    expect(categorizeDayShape([22, 23, 1])).toBe("after-hours");
  });

  it("returns 'back-to-back' when 4+ meetings cluster in 5 hours", () => {
    expect(categorizeDayShape([9, 10, 11, 12, 14])).toBe("back-to-back");
  });

  it("returns 'balanced' when meetings span multiple parts of the day", () => {
    expect(categorizeDayShape([9, 14, 19])).toBe("balanced");
  });

  it("prefers 'back-to-back' over 'morning-heavy' when both could apply", () => {
    expect(categorizeDayShape([7, 8, 9, 10])).toBe("back-to-back");
  });

  it("counts a single meeting as the matching period (not balanced)", () => {
    expect(categorizeDayShape([10])).toBe("morning-heavy");
    expect(categorizeDayShape([14])).toBe("afternoon-heavy");
    expect(categorizeDayShape([18])).toBe("evening-heavy");
  });
});
