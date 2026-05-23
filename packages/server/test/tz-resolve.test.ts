// Tests for resolveTenantTz + localizeRows — v0.4.14.
//
// v0.4.14 changed where TZ lives: from a (broken) memory.recall path
// to the executive_assistant__user_preferences table. These tests
// mock the db query chain to match what drizzle's
// .select().from().where().limit() actually returns.

import { describe, it, expect } from "vitest";
import type { ToolContext } from "@boringos/module-sdk";
import { resolveTenantTz, localizeRows } from "../src/services/tz.js";

function ctx(): ToolContext {
  return {
    tenantId: "00000000-0000-0000-0000-000000000001",
    invokedBy: "agent",
  };
}

// Mock the prefs lookup. Drizzle chain we use in resolveTenantTz:
//   db.select({...}).from(userPreferences).where(...).limit(1)
// Returns: Array<{ value: any }>.
//
// prefsByKey lets a test return different rows for different keys.
// The chain inspects no actual SQL, so we drive behaviour by call order.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeDeps(prefsByKey: Record<string, any | null>): any {
  const keysQueried: string[] = [];
  // We can't easily inspect the .where(eq(...)) value in our mock, so
  // the chain pops keys in the order they appear in resolveTenantTz:
  // ["current_location", "home_location"]. That matches the keysInOrder
  // array in the implementation.
  const keyOrder = ["current_location", "home_location"];
  return {
    db: {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => {
              const k = keyOrder[keysQueried.length];
              keysQueried.push(k!);
              const v = prefsByKey[k!];
              return v == null ? [] : [{ value: v }];
            },
          }),
        }),
      }),
    },
    getEventBus: () => null,
    toolRegistry: null,
  };
}

describe("resolveTenantTz (v0.4.14 — preferences-backed)", () => {
  it("returns explicit override without touching the DB", async () => {
    const deps = makeDeps({});
    const result = await resolveTenantTz(ctx(), deps, "America/Los_Angeles");
    expect(result).toEqual({ tz: "America/Los_Angeles" });
  });

  it("returns current_location.tz when set", async () => {
    const deps = makeDeps({
      current_location: { label: "Mumbai", tz: "Asia/Kolkata" },
      home_location: { label: "Mumbai", tz: "Asia/Kolkata" },
    });
    const result = await resolveTenantTz(ctx(), deps);
    expect(result).toEqual({ tz: "Asia/Kolkata" });
  });

  it("falls back to home_location.tz when current_location is empty", async () => {
    const deps = makeDeps({
      current_location: null,
      home_location: { label: "Mumbai", tz: "Asia/Kolkata" },
    });
    const result = await resolveTenantTz(ctx(), deps);
    expect(result).toEqual({ tz: "Asia/Kolkata" });
  });

  it("returns tz_not_configured when both keys are absent — no silent UTC", async () => {
    const deps = makeDeps({ current_location: null, home_location: null });
    const result = await resolveTenantTz(ctx(), deps);
    expect(result).toEqual({ error: "tz_not_configured" });
  });

  it("treats a value missing the tz field as absent", async () => {
    const deps = makeDeps({
      current_location: { label: "Mumbai" /* no tz */ },
      home_location: { label: "Mumbai", tz: "Asia/Kolkata" },
    });
    const result = await resolveTenantTz(ctx(), deps);
    expect(result).toEqual({ tz: "Asia/Kolkata" });
  });
});

describe("localizeRows (v0.4.14)", () => {
  it("enriches rows when tz resolves and preserves originals", async () => {
    const deps = makeDeps({
      current_location: { label: "Mumbai", tz: "Asia/Kolkata" },
      home_location: { label: "Mumbai", tz: "Asia/Kolkata" },
    });
    const rows = [
      {
        id: "m1",
        title: "CTO Final Round",
        startsAt: new Date("2026-05-16T10:00:00.000Z"),
        endsAt: new Date("2026-05-16T11:00:00.000Z"),
      },
    ];
    const result = await localizeRows(rows, ctx(), deps);
    expect("tz" in result).toBe(true);
    if ("tz" in result) {
      expect(result.tz).toBe("Asia/Kolkata");
      expect(result.rows[0]).toMatchObject({
        id: "m1",
        title: "CTO Final Round",
        startsAtLocal: "15:30",
        endsAtLocal: "16:30",
        dayPart: "afternoon",
        tzAbbr: "IST",
      });
    }
  });

  it("returns tzError when prefs are unset", async () => {
    const deps = makeDeps({ current_location: null, home_location: null });
    const rows = [
      { id: "m1", startsAt: new Date("2026-05-16T10:00:00.000Z"), endsAt: null },
    ];
    const result = await localizeRows(rows, ctx(), deps);
    expect("tzError" in result).toBe(true);
  });
});
