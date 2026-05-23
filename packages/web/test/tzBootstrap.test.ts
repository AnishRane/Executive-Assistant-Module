// Tests for the browser-side TZ bootstrap that writes
// user.current_location (and user.home_location on first run) to
// memory whenever /executive is opened from a new timezone.
//
// Pure-ish function — dependencies (callTool + getBrowserTz) are
// injected so we can drive every code path without a browser.

import { describe, it, expect, vi } from "vitest";
import { bootstrapTimezone } from "../src/lib/tzBootstrap.js";

describe("bootstrapTimezone", () => {
  it("does nothing when current_location already matches the browser TZ", async () => {
    const callTool = vi
      .fn()
      .mockResolvedValueOnce({
        data: { value: { tz: "Asia/Kolkata", label: "Kolkata" } },
      })
      .mockResolvedValueOnce({
        data: { value: { tz: "Asia/Kolkata", label: "Kolkata" } },
      });
    const result = await bootstrapTimezone(callTool, () => "Asia/Kolkata");
    expect(result.tz).toBe("Asia/Kolkata");
    expect(result.wrote).toBe("nothing");
    // Two recalls (current + home), no remembers
    expect(callTool).toHaveBeenCalledTimes(2);
  });

  it("writes user.current_location when the browser TZ differs from stored", async () => {
    const callTool = vi
      .fn()
      .mockResolvedValueOnce({
        data: { value: { tz: "Asia/Kolkata", label: "Kolkata" } },
      })
      .mockResolvedValueOnce({ data: {} }) // remember current
      .mockResolvedValueOnce({
        data: { value: { tz: "Asia/Kolkata", label: "Kolkata" } },
      }); // home already set
    const result = await bootstrapTimezone(callTool, () => "America/New_York");

    expect(result.wrote).toBe("current");
    expect(result.tz).toBe("America/New_York");
    const rememberCall = callTool.mock.calls[1]!;
    expect(rememberCall[0]).toBe("executive-assistant.preferences.set");
    // v0.1.8 — bootstrap-time label is the FULL IANA tz so the UI is
    // honest that no real reverse-geocoded place is known yet. The
    // geolocation effect upgrades this to "Suburb, State" later.
    expect(rememberCall[1]).toMatchObject({
      key: "current_location",
      value: { tz: "America/New_York", label: "America/New_York" },
    });
  });

  it("writes both current and home when home is empty (first-time setup)", async () => {
    const callTool = vi
      .fn()
      .mockResolvedValueOnce({ data: { value: null } }) // current empty
      .mockResolvedValueOnce({ data: {} }) // remember current
      .mockResolvedValueOnce({ data: { value: null } }) // home empty
      .mockResolvedValueOnce({ data: {} }); // remember home
    const result = await bootstrapTimezone(callTool, () => "Asia/Kolkata");

    expect(result.wrote).toBe("current+home");
    // v0.1.8 — bootstrap label is the full IANA tz.
    expect(callTool.mock.calls[3]![1]).toMatchObject({
      key: "home_location",
      value: { tz: "Asia/Kolkata", label: "Asia/Kolkata" },
    });
  });

  it("returns wrote=nothing when the browser cannot resolve a timezone", async () => {
    const callTool = vi.fn();
    const result = await bootstrapTimezone(callTool, () => null);
    expect(result.tz).toBeNull();
    expect(result.wrote).toBe("nothing");
    expect(callTool).not.toHaveBeenCalled();
  });

  it("keeps the full IANA tz as the bootstrap-time label (v0.1.8)", async () => {
    // v0.1.8 — labelFromIana now returns the full IANA tz string
    // rather than the trailing segment. Rationale: the trailing
    // segment looked like a city name but had no geographic truth
    // (e.g. "Asia/Calcutta" → "Calcutta" while the user was actually
    // in Mumbai). The full IANA tz signals "we only know the
    // timezone right now" until the geolocation effect upgrades it
    // via reverse geocoding ("Ambarnath, Maharashtra").
    const callTool = vi
      .fn()
      .mockResolvedValueOnce({ data: { value: null } })
      .mockResolvedValueOnce({ data: {} })
      .mockResolvedValueOnce({ data: { value: null } })
      .mockResolvedValueOnce({ data: {} });
    await bootstrapTimezone(callTool, () => "America/Los_Angeles");
    expect(callTool.mock.calls[1]![1].value.label).toBe("America/Los_Angeles");
  });
});
