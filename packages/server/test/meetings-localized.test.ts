// v0.4.14 rewrite: meetings.list / meetings.get integration tests now
// mock the db chain directly (the new resolveTenantTz reads from the
// preferences table, no more memory.recall). Test mocks are driven by
// call order to match the actual handler's query sequence.

import { describe, it, expect } from "vitest";
import type { ToolContext } from "@boringos/module-sdk";

import { createMeetingTools } from "../src/tools/meetings.js";

function ctx(): ToolContext {
  return { tenantId: "00000000-0000-0000-0000-000000000001", invokedBy: "agent" };
}

function meetingRow() {
  return {
    id: "m1",
    tenantId: ctx().tenantId,
    googleEventId: "g1",
    title: "CTO Final Round",
    startsAt: new Date("2026-05-16T10:00:00.000Z"),
    endsAt: new Date("2026-05-16T11:00:00.000Z"),
    location: null,
    conferenceLink: null,
    organizerEmail: null,
    description: null,
    brief: null,
    gmailThreadId: null,
    lastChangeAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

// Thenable chain proxy: every drizzle chain method returns `this`,
// resolves to `rows` when awaited. Handles all access patterns the
// handlers might use without needing to enumerate them.
class ChainProxy {
  constructor(private rows: unknown[]) {}
  from() { return this; }
  innerJoin() { return this; }
  where() { return this; }
  orderBy() { return this; }
  limit() { return this; }
  offset() { return this; }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  then(onFulfilled: any, onRejected: any) {
    return Promise.resolve(this.rows).then(onFulfilled, onRejected);
  }
}

// Mock db whose .select() returns successive row sets per call.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeMockDb(callResults: unknown[][]): any {
  let idx = 0;
  return {
    db: {
      select: () => new ChainProxy(callResults[idx++] ?? []),
    },
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeDeps(handle: { db: any }): any {
  return {
    db: handle.db,
    getEventBus: () => null,
    toolRegistry: null,
  };
}

function getTool(tools: { name: string }[], name: string) {
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`tool ${name} not found`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return t as any;
}

describe("meetings.list — localized fields (v0.4.14)", () => {
  it("adds startsAtLocal / endsAtLocal / dayPart / tzAbbr per row when prefs has a tz", async () => {
    // v0.4.47 call order: 1) meetings, 2) attendees (per-meeting join),
    // 3) preferences current_location.
    const handle = makeMockDb([
      [meetingRow()],
      [], // no attendees
      [{ value: { label: "Mumbai", tz: "Asia/Kolkata" } }],
    ]);
    const tool = getTool(createMeetingTools(makeDeps(handle)), "meetings.list");
    const r = await tool.handler({}, ctx());

    expect(r.ok).toBe(true);
    expect(r.result.data[0]).toMatchObject({
      id: "m1",
      startsAtLocal: "15:30",
      endsAtLocal: "16:30",
      dayPart: "afternoon",
      tzAbbr: "IST",
      tzIana: "Asia/Kolkata",
    });
    expect(r.result.tzIana).toBe("Asia/Kolkata");
  });

  it("includes tzError and omits *Local fields when no preference is set", async () => {
    // v0.4.47 call order: 1) meetings, 2) attendees, 3) prefs current,
    // 4) prefs home (when current is empty).
    const handle = makeMockDb([[meetingRow()], [], [], []]);
    const tool = getTool(createMeetingTools(makeDeps(handle)), "meetings.list");
    const r = await tool.handler({}, ctx());

    expect(r.ok).toBe(true);
    expect(r.result.tzError).toBe("tz_not_configured");
    expect(r.result.data[0]).not.toHaveProperty("startsAtLocal");
  });

  // v0.4.47: meetings.list now returns attendees per row, so the agent
  // doesn't need to call meetings.get per meeting just to read them.
  // Eliminates ~N round-trips during Day Brief composition.
  it("includes an attendees array per row", async () => {
    const handle = makeMockDb([
      [meetingRow(), { ...meetingRow(), id: "m2" }],
      [
        { meetingId: "m1", email: "alex@acme.com", name: "Alex", title: "VP", company: "Acme", bio: null, isExternal: true },
        { meetingId: "m1", email: "sam@acme.com", name: "Sam", title: null, company: "Acme", bio: null, isExternal: true },
        { meetingId: "m2", email: "pat@other.com", name: "Pat", title: null, company: "Other", bio: null, isExternal: true },
      ],
      [{ value: { label: "Mumbai", tz: "Asia/Kolkata" } }],
    ]);
    const tool = getTool(createMeetingTools(makeDeps(handle)), "meetings.list");
    const r = await tool.handler({}, ctx());

    expect(r.ok).toBe(true);
    expect(r.result.data[0].attendees).toHaveLength(2);
    expect(r.result.data[0].attendees[0]).toMatchObject({ email: "alex@acme.com", name: "Alex" });
    expect(r.result.data[1].attendees).toHaveLength(1);
    expect(r.result.data[1].attendees[0]).toMatchObject({ email: "pat@other.com" });
  });
});

describe("meetings.get — localized fields (v0.4.14)", () => {
  it("returns the meeting with localized fields when tz resolves", async () => {
    // Call order: 1) select meeting, 2) select attendees, 3) select prefs current
    const handle = makeMockDb([
      [meetingRow()],
      [],
      [{ value: { label: "Mumbai", tz: "Asia/Kolkata" } }],
    ]);
    const tool = getTool(createMeetingTools(makeDeps(handle)), "meetings.get");
    const r = await tool.handler({ meetingId: "m1" }, ctx());

    expect(r.ok).toBe(true);
    expect(r.result.data).toMatchObject({
      id: "m1",
      startsAtLocal: "15:30",
      endsAtLocal: "16:30",
      dayPart: "afternoon",
      tzAbbr: "IST",
      tzIana: "Asia/Kolkata",
      attendees: [],
    });
  });
});
