// Tests for services/tz.ts — the server-side localization functions
// that take the LLM out of timezone math.
//
// These are pure functions. No DB, no memory, no LLM. Given a UTC ISO
// string + IANA timezone name, return correctly localized output.

import { describe, it, expect } from "vitest";
import {
  formatLocal,
  formatLocalLong,
  dayPartFromHour,
  tzAbbr,
  localizeTimes,
} from "../src/services/tz.js";

describe("formatLocal", () => {
  it("converts UTC ISO to HH:mm in the given IANA timezone (Asia/Kolkata)", () => {
    // 10:00 UTC = 15:30 IST (UTC+5:30)
    expect(formatLocal("2026-05-16T10:00:00.000Z", "Asia/Kolkata")).toBe("15:30");
  });

  it("converts UTC ISO to HH:mm in America/New_York during EDT", () => {
    // 14:30 UTC on May 16 = 10:30 EDT (UTC-4 in summer)
    expect(formatLocal("2026-05-16T14:30:00.000Z", "America/New_York")).toBe("10:30");
  });

  it("zero-pads single-digit hours", () => {
    // 03:05 UTC = 08:35 IST
    expect(formatLocal("2026-05-16T03:05:00.000Z", "Asia/Kolkata")).toBe("08:35");
  });

  it("returns 00:00 for midnight in the target timezone", () => {
    // 18:30 UTC May 15 = 00:00 IST May 16
    expect(formatLocal("2026-05-15T18:30:00.000Z", "Asia/Kolkata")).toBe("00:00");
  });
});

describe("formatLocalLong", () => {
  it("returns a 'Sat, May 16 · 15:30 IST' style string", () => {
    expect(
      formatLocalLong("2026-05-16T10:00:00.000Z", "Asia/Kolkata"),
    ).toBe("Sat, May 16 · 15:30 IST");
  });

  it("crosses the date line correctly when local date differs from UTC", () => {
    // 22:00 UTC May 15 = 03:30 May 16 IST. Long format must show May 16.
    expect(
      formatLocalLong("2026-05-15T22:00:00.000Z", "Asia/Kolkata"),
    ).toBe("Sat, May 16 · 03:30 IST");
  });

  it("emits the New York abbreviation during EDT", () => {
    expect(
      formatLocalLong("2026-05-16T14:30:00.000Z", "America/New_York"),
    ).toBe("Sat, May 16 · 10:30 EDT");
  });
});

describe("dayPartFromHour", () => {
  it("treats 5–11 as morning", () => {
    expect(dayPartFromHour(5)).toBe("morning");
    expect(dayPartFromHour(8)).toBe("morning");
    expect(dayPartFromHour(11)).toBe("morning");
  });

  it("treats 12–16 as afternoon", () => {
    expect(dayPartFromHour(12)).toBe("afternoon");
    expect(dayPartFromHour(15)).toBe("afternoon");
    expect(dayPartFromHour(16)).toBe("afternoon");
  });

  it("treats 17–20 as evening", () => {
    expect(dayPartFromHour(17)).toBe("evening");
    expect(dayPartFromHour(20)).toBe("evening");
  });

  it("treats 21–4 as night (wraps midnight)", () => {
    expect(dayPartFromHour(21)).toBe("night");
    expect(dayPartFromHour(23)).toBe("night");
    expect(dayPartFromHour(0)).toBe("night");
    expect(dayPartFromHour(4)).toBe("night");
  });
});

describe("localizeTimes", () => {
  it("emits the full localization bundle for a meeting with start + end", () => {
    const result = localizeTimes(
      {
        startsAt: new Date("2026-05-16T10:00:00.000Z"),
        endsAt: new Date("2026-05-16T10:30:00.000Z"),
      },
      "Asia/Kolkata",
    );
    expect(result).toEqual({
      startsAtLocal: "15:30",
      endsAtLocal: "16:00",
      startsAtLocalLong: "Sat, May 16 · 15:30 IST",
      dayPart: "afternoon",
      tzAbbr: "IST",
      tzIana: "Asia/Kolkata",
    });
  });

  it("returns endsAtLocal: null when the item has no end time", () => {
    const result = localizeTimes(
      {
        startsAt: new Date("2026-05-16T10:00:00.000Z"),
        endsAt: null,
      },
      "Asia/Kolkata",
    );
    expect(result.startsAtLocal).toBe("15:30");
    expect(result.endsAtLocal).toBeNull();
    expect(result.dayPart).toBe("afternoon");
  });

  it("computes dayPart from the LOCAL hour, not the UTC hour", () => {
    // 22:00 UTC = 03:30 IST → night
    const result = localizeTimes(
      { startsAt: new Date("2026-05-15T22:00:00.000Z"), endsAt: null },
      "Asia/Kolkata",
    );
    expect(result.startsAtLocal).toBe("03:30");
    expect(result.dayPart).toBe("night");
  });
});

describe("tzAbbr", () => {
  it("returns 'IST' for Asia/Kolkata on a normal date", () => {
    expect(tzAbbr("2026-05-16T10:00:00.000Z", "Asia/Kolkata")).toBe("IST");
  });

  it("returns 'EDT' for America/New_York in summer", () => {
    expect(tzAbbr("2026-07-04T16:00:00.000Z", "America/New_York")).toBe("EDT");
  });

  it("returns 'EST' for America/New_York in winter", () => {
    expect(tzAbbr("2026-01-15T16:00:00.000Z", "America/New_York")).toBe("EST");
  });

  it("returns 'GMT' for Europe/London in winter", () => {
    expect(tzAbbr("2026-01-15T12:00:00.000Z", "Europe/London")).toBe("GMT");
  });

  it("returns 'BST' for Europe/London in summer", () => {
    expect(tzAbbr("2026-07-15T12:00:00.000Z", "Europe/London")).toBe("BST");
  });
});
