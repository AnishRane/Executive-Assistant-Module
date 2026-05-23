// Reconciler tests — verify the PNR-dedup branch logic with a small
// mock db. The DB-level partial unique index
// (ea__trip_legs_pnr_uniq) is the authoritative constraint; this
// test verifies the *application* dedup logic takes the expected
// branch given an existing leg.
//
// Full end-to-end dedup against a real Postgres lands when EA is
// installed on a running BoringOS host (Phase 1b's done condition).

import { describe, it, expect } from "vitest";
import { reconcileLeg, findOrCreateTrip } from "../src/services/reconciler.js";
import type { ParsedLeg } from "../src/types.js";

interface MockDbOpts {
  selectResult?: unknown[];
  insertResult?: unknown[];
  updateResult?: unknown[];
}

interface MockDbHandle {
  calls: { select: number; insert: number; update: number };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any;
}

function makeMockDb(opts: MockDbOpts): MockDbHandle {
  const calls = { select: 0, insert: 0, update: 0 };
  const db = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => {
            calls.select++;
            return opts.selectResult ?? [];
          },
        }),
      }),
    }),
    insert: () => ({
      values: () => ({
        returning: async () => {
          calls.insert++;
          return opts.insertResult ?? [];
        },
      }),
    }),
    update: () => ({
      set: () => ({
        where: () => ({
          returning: async () => {
            calls.update++;
            return opts.updateResult ?? [];
          },
        }),
      }),
    }),
  };
  return { calls, db };
}

const PARSED_FLIGHT: ParsedLeg = {
  kind: "flight",
  provider: "United",
  confirmationCode: "XYZ123",
  startsAt: "2026-05-14T09:30:00Z",
  endsAt: null,
  originLocation: "SFO",
  destinationLocation: "JFK",
  currentState: { flightNumber: "UA1234" },
  tripHint: { destination: "JFK", startsOn: "2026-05-14", endsOn: null },
};

describe("reconcileLeg PNR dedup", () => {
  it("takes the UPDATE branch when an existing leg matches the PNR", async () => {
    const existing = {
      id: "leg-1",
      tripId: "trip-1",
      kind: "flight",
      confirmationCode: "XYZ123",
      provider: "United",
      sourceMessageIds: ["msg-1"],
      currentState: { flightNumber: "UA1234" },
      startsAt: new Date("2026-05-14T09:30:00Z"),
      endsAt: null,
      originLocation: "SFO",
      destinationLocation: "JFK",
      lastReconciledAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const updated = { ...existing, sourceMessageIds: ["msg-1", "msg-2"] };
    const { db, calls } = makeMockDb({
      selectResult: [existing],
      updateResult: [updated],
    });

    const result = await reconcileLeg(db, "trip-1", PARSED_FLIGHT, "msg-2");
    expect(result.isNew).toBe(false);
    expect(calls.select).toBe(1);
    expect(calls.update).toBe(1);
    expect(calls.insert).toBe(0);
  });

  it("takes the INSERT branch when no existing leg matches", async () => {
    const inserted = {
      id: "leg-new",
      tripId: "trip-1",
      kind: "flight",
      confirmationCode: "XYZ123",
      provider: "United",
      sourceMessageIds: ["msg-1"],
      currentState: { flightNumber: "UA1234" },
      startsAt: new Date("2026-05-14T09:30:00Z"),
      endsAt: null,
      originLocation: "SFO",
      destinationLocation: "JFK",
      lastReconciledAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const { db, calls } = makeMockDb({
      selectResult: [],
      insertResult: [inserted],
    });

    const result = await reconcileLeg(db, "trip-1", PARSED_FLIGHT, "msg-1");
    expect(result.isNew).toBe(true);
    expect(calls.select).toBe(1);
    expect(calls.insert).toBe(1);
    expect(calls.update).toBe(0);
  });

  it("skips the dedup lookup entirely when confirmationCode is null", async () => {
    const noCodeParsed: ParsedLeg = { ...PARSED_FLIGHT, confirmationCode: null };
    const inserted = { id: "leg-x" };
    const { db, calls } = makeMockDb({
      insertResult: [inserted],
    });
    const result = await reconcileLeg(db, "trip-1", noCodeParsed, "msg-1");
    expect(result.isNew).toBe(true);
    // No SELECT happens — we can't dedup without a code.
    expect(calls.select).toBe(0);
    expect(calls.insert).toBe(1);
  });
});

describe("findOrCreateTrip", () => {
  it("creates a new trip when destination has no match", async () => {
    const newTrip = {
      id: "trip-new",
      tenantId: "t1",
      label: "JFK",
      destination: "JFK",
      startsOn: "2026-05-14",
      endsOn: null,
      status: "planned",
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const { db, calls } = makeMockDb({
      selectResult: [],
      insertResult: [newTrip],
    });
    const result = await findOrCreateTrip(db, "t1", PARSED_FLIGHT.tripHint);
    expect(result.id).toBe("trip-new");
    expect(calls.select).toBe(1);
    expect(calls.insert).toBe(1);
  });

  it("returns the existing trip without inserting when one matches", async () => {
    const existingTrip = {
      id: "trip-existing",
      tenantId: "t1",
      label: "JFK",
      destination: "JFK",
      startsOn: "2026-05-14",
      endsOn: "2026-05-16",
      status: "planned",
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const { db, calls } = makeMockDb({
      selectResult: [existingTrip],
    });
    const result = await findOrCreateTrip(db, "t1", PARSED_FLIGHT.tripHint);
    expect(result.id).toBe("trip-existing");
    expect(calls.select).toBe(1);
    expect(calls.insert).toBe(0);
  });
});
