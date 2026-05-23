// Tests for timeline_items tools — v0.4.54 introduces create_batch.
//
// RED: write_batch must accept { snapshotId, items: [{ kind, refId, ... }] }
//      and insert N rows in one call. The agent uses this instead of
//      N separate timeline_items.create calls so haiku stays under
//      its tool-budget threshold.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ToolContext } from "@boringos/module-sdk";

import { createTimelineItemTools } from "../src/tools/timeline_items.js";

function ctx(): ToolContext {
  return { tenantId: "00000000-0000-0000-0000-000000000001", invokedBy: "agent" };
}

function getTool(tools: { name: string }[], name: string) {
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`tool ${name} not found`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return t as any;
}

interface MockDbHandle {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any;
  inserts: unknown[];
}

function makeMockDb(opts: {
  snapshotExists?: boolean;
  meetingLookups?: Map<string, { startsAt: Date; endsAt: Date }>;
} = {}): MockDbHandle {
  const inserts: unknown[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const finalSelect: any = {
    limit: async () => (opts.snapshotExists !== false ? [{ id: "snap-1" }] : []),
    orderBy: () => finalSelect,
  };
  const db = {
    select: () => ({
      from: () => ({
        where: () => finalSelect,
      }),
    }),
    insert: () => ({
      values: (v: unknown) => {
        inserts.push(v);
        return {
          returning: async () => {
            // For batch: v is an array, return array. For single: v is an obj.
            const arr = Array.isArray(v) ? v : [v];
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            return arr.map((row: any) => ({ ...row, id: row.id ?? `ti-${inserts.length}` }));
          },
        };
      },
    }),
  };
  return { db, inserts };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeDeps(handle: MockDbHandle): any {
  return {
    db: handle.db,
    getEventBus: () => null,
    toolRegistry: null,
  };
}

describe("timeline_items.create_batch (v0.4.54)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("is registered as a tool", () => {
    const handle = makeMockDb();
    const tools = createTimelineItemTools(makeDeps(handle));
    const t = tools.find((x) => x.name === "timeline_items.create_batch");
    expect(t).toBeDefined();
  });

  it("inserts N rows in one call when items array has N entries", async () => {
    const handle = makeMockDb({ snapshotExists: true });
    const tool = getTool(
      createTimelineItemTools(makeDeps(handle)),
      "timeline_items.create_batch",
    );
    const r = await tool.handler(
      {
        snapshotId: "00000000-0000-0000-0000-000000000aaa",
        items: [
          { kind: "meeting", refId: "00000000-0000-0000-0000-0000000000a1", startsAt: "2026-05-22T09:30:00Z", endsAt: "2026-05-22T10:00:00Z" },
          { kind: "meeting", refId: "00000000-0000-0000-0000-0000000000a2", startsAt: "2026-05-22T10:00:00Z", endsAt: "2026-05-22T11:00:00Z" },
          { kind: "ooo",     refId: "00000000-0000-0000-0000-0000000000b1", startsAt: "2026-05-22T13:00:00Z", endsAt: "2026-05-22T14:00:00Z" },
        ],
      },
      ctx(),
    );

    expect(r.ok).toBe(true);
    if (r.ok) {
      const data = r.result.data as { created: number; items: unknown[] };
      expect(data.created).toBe(3);
      expect(data.items).toHaveLength(3);
    }
  });

  it("returns not_found when snapshot is in a different tenant", async () => {
    const handle = makeMockDb({ snapshotExists: false });
    const tool = getTool(
      createTimelineItemTools(makeDeps(handle)),
      "timeline_items.create_batch",
    );
    const r = await tool.handler(
      {
        snapshotId: "00000000-0000-0000-0000-000000000aaa",
        items: [{ kind: "meeting", refId: "00000000-0000-0000-0000-0000000000a1", startsAt: "2026-05-22T09:30:00Z", endsAt: "2026-05-22T10:00:00Z" }],
      },
      ctx(),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("not_found");
  });

  it("returns empty result for empty items array (no-op)", async () => {
    const handle = makeMockDb({ snapshotExists: true });
    const tool = getTool(
      createTimelineItemTools(makeDeps(handle)),
      "timeline_items.create_batch",
    );
    const r = await tool.handler(
      { snapshotId: "00000000-0000-0000-0000-000000000aaa", items: [] },
      ctx(),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      const data = r.result.data as { created: number };
      expect(data.created).toBe(0);
    }
  });
});
