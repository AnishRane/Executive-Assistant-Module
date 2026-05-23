// Tests for the Phase E compose hash + maybe_create_task gate.
//
// Two layers:
//   1. compose_hash — the pure stringify+sha256 function is fully
//      hermetic. We test stability (same inputs → same hash) and
//      sensitivity (any field change → different hash).
//   2. maybe_create_task — the gate tool, mocked-db + mocked-invoke.
//      Three branches:
//         - state_hash matches → skipped:true
//         - state_hash differs → task created via invoke
//         - no prior snapshot → task created (first compose)

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ToolContext } from "@boringos/module-sdk";
import { hashOf } from "../src/services/compose_hash.js";
import { createComposeTools } from "../src/tools/compose.js";

// ─── compose_hash tests ─────────────────────────────────────────

describe("hashOf", () => {
  function baseline() {
    return {
      meetings: [
        {
          id: "m-1",
          title: "Klein 1:1",
          startsAt: "2026-05-15T09:30:00.000Z",
          endsAt: "2026-05-15T10:00:00.000Z",
          lastChangeAt: "2026-05-15T08:00:00.000Z",
        },
      ],
      deltaIds: ["d-1"],
      conflictIds: ["c-1"],
      oooWindows: [
        { id: "o-1", startsAt: "2026-05-15T14:00:00.000Z", endsAt: "2026-05-15T18:00:00.000Z" },
      ],
      weather: { id: "w-1", fetchedAt: "2026-05-15T06:00:00.000Z" },
    };
  }

  it("returns the same hash for identical inputs", () => {
    const a = hashOf(baseline());
    const b = hashOf(baseline());
    expect(a).toBe(b);
    expect(a).toMatch(/^[a-f0-9]{64}$/);
  });

  it("is order-independent — sorts meetings + deltas + conflicts + OOO by id", () => {
    const a = hashOf({
      meetings: [
        { id: "m-1", title: "A", startsAt: "2026-05-15T09:30:00.000Z", endsAt: "2026-05-15T10:00:00.000Z", lastChangeAt: null },
        { id: "m-2", title: "B", startsAt: "2026-05-15T10:00:00.000Z", endsAt: "2026-05-15T11:00:00.000Z", lastChangeAt: null },
      ],
      deltaIds: ["d-1", "d-2"],
      conflictIds: ["c-2", "c-1"],
      oooWindows: [],
      weather: null,
    });
    const b = hashOf({
      meetings: [
        { id: "m-2", title: "B", startsAt: "2026-05-15T10:00:00.000Z", endsAt: "2026-05-15T11:00:00.000Z", lastChangeAt: null },
        { id: "m-1", title: "A", startsAt: "2026-05-15T09:30:00.000Z", endsAt: "2026-05-15T10:00:00.000Z", lastChangeAt: null },
      ],
      deltaIds: ["d-2", "d-1"],
      conflictIds: ["c-1", "c-2"],
      oooWindows: [],
      weather: null,
    });
    expect(a).toBe(b);
  });

  it("changes hash when a meeting title changes", () => {
    const a = hashOf(baseline());
    const b = baseline();
    b.meetings[0]!.title = "Klein 1:1 — moved";
    expect(hashOf(b)).not.toBe(a);
  });

  it("changes hash when a meeting starts_at changes", () => {
    const a = hashOf(baseline());
    const b = baseline();
    b.meetings[0]!.startsAt = "2026-05-15T08:30:00.000Z";
    expect(hashOf(b)).not.toBe(a);
  });

  it("changes hash when a delta is added", () => {
    const a = hashOf(baseline());
    const b = baseline();
    b.deltaIds.push("d-2");
    expect(hashOf(b)).not.toBe(a);
  });

  it("changes hash when a conflict is added", () => {
    const a = hashOf(baseline());
    const b = baseline();
    b.conflictIds.push("c-99");
    expect(hashOf(b)).not.toBe(a);
  });

  it("changes hash when an OOO window is added", () => {
    const a = hashOf(baseline());
    const b = baseline();
    b.oooWindows.push({
      id: "o-99",
      startsAt: "2026-05-15T20:00:00.000Z",
      endsAt: "2026-05-15T22:00:00.000Z",
    });
    expect(hashOf(b)).not.toBe(a);
  });

  it("changes hash when weather.fetched_at advances", () => {
    const a = hashOf(baseline());
    const b = baseline();
    b.weather!.fetchedAt = "2026-05-15T06:15:00.000Z";
    expect(hashOf(b)).not.toBe(a);
  });

  it("returns a stable hash for the all-empty state", () => {
    const empty = {
      meetings: [],
      deltaIds: [],
      conflictIds: [],
      oooWindows: [],
      weather: null,
    };
    expect(hashOf(empty)).toBe(hashOf(empty));
  });
});

// ─── compose.day_context tests (v0.4.54) ─────────────────────────

// ─── compose.write_meeting_brief tests (v0.1.4) ───────────────────

describe("compose.write_meeting_brief", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("saves the brief AND fires comments.post + tasks.patch atomically", async () => {
    // Mock the underlying invokes for comments.post + tasks.patch.
    invokeMock.mockImplementation((_deps, name) => {
      const ok = (data: unknown) => Promise.resolve({ ok: true, result: { data } });
      if (name === "framework.comments.post") return ok({ id: "comment-1" });
      if (name === "framework.tasks.patch") return ok({ id: "task-1" });
      return Promise.resolve({ ok: false, error: { code: "not_found", message: `no mock for ${name}`, retryable: false } });
    });

    // Mock db.update().set(...).where(...).returning() chain for set_brief,
    // and db.execute() for the task lookup.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const updateChain: any = {
      set: () => updateChain,
      where: () => updateChain,
      returning: async () => [{ id: "00000000-0000-0000-0000-0000000000a1", brief: "Eighty word brief here." }],
    };
    const handle = {
      db: {
        update: () => updateChain,
        execute: async () =>
          [{ id: "00000000-0000-0000-0000-000000000bbb" }] as unknown,
      },
      calls: { select: 0, insertAwaited: 0, insertValues: [], execute: 0 },
    };

    const tool = getTool(
      createComposeTools(makeDeps(handle)),
      "compose.write_meeting_brief",
    );
    const r = await tool.handler(
      {
        meetingId: "00000000-0000-0000-0000-0000000000a1",
        brief: "Eighty word brief here.",
      },
      ctx(),
    );

    expect(r.ok).toBe(true);
    // Two invokes fired: comments.post + tasks.patch
    expect(invokeMock).toHaveBeenCalledTimes(2);
    expect(invokeMock.mock.calls[0]?.[1]).toBe("framework.comments.post");
    expect(invokeMock.mock.calls[1]?.[1]).toBe("framework.tasks.patch");
  });

  it("returns not_found when the meeting doesn't exist", async () => {
    // Mock update().returning() returns empty array
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const updateChain: any = {
      set: () => updateChain,
      where: () => updateChain,
      returning: async () => [],
    };
    const handle = {
      db: {
        update: () => updateChain,
        execute: async () => [] as unknown,
      },
      calls: { select: 0, insertAwaited: 0, insertValues: [], execute: 0 },
    };

    const tool = getTool(
      createComposeTools(makeDeps(handle)),
      "compose.write_meeting_brief",
    );
    const r = await tool.handler(
      {
        meetingId: "00000000-0000-0000-0000-0000000000ff",
        brief: "Brief.",
      },
      ctx(),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("not_found");
    // Should not fire comment/patch if meeting wasn't found
    expect(invokeMock).not.toHaveBeenCalled();
  });
});

describe("compose.day_context", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    computeDaySignalMock.mockReset();
  });

  it("aggregates meetings + ooo + trips + conflicts + day_signal into one response", async () => {
    // Mock day_signal — pure aggregation, test it elsewhere.
    computeDaySignalMock.mockResolvedValue({
      forDate: "2026-05-22",
      meetingCount: 1,
      oooCount: 0,
      dayShape: "morning-heavy",
      firstMeetingLocal: "09:30",
      lastMeetingEndLocal: "10:00",
      travel: null,
    });

    // Mock the underlying internal invokes that day_context fans out.
    invokeMock.mockImplementation((_deps, name, _input, _ctx) => {
      const ok = (data: unknown) => Promise.resolve({ ok: true, result: { data } });
      switch (name) {
        case "executive-assistant.meetings.list":
          return ok([{ id: "m-1", title: "Vimtara", attendees: [] }]);
        case "executive-assistant.ooo.list":
          return ok([]);
        case "executive-assistant.trips.list":
          return ok([]);
        case "executive-assistant.conflicts.list":
          return ok([]);
        case "executive-assistant.preferences.get":
          return ok({ value: { name: "Anish" } });
        case "memory.recall":
          return ok(null); // memory empty
        case "executive-assistant.weather.fetch_for_date":
          return ok({ tempHighC: 28 });
        default:
          return Promise.resolve({ ok: false, error: { code: "not_found", message: `no mock for ${name}`, retryable: false } });
      }
    });

    // computeDaySignal in compose.day_context queries the DB directly.
    // Mock db.execute / select returns enough for it to not blow up.
    const handle = makeMockDb({ priorSnapshotHash: null });
    const tool = getTool(
      createComposeTools(makeDeps(handle)),
      "compose.day_context",
    );
    const r = await tool.handler({ forDate: "2026-05-22" }, ctx());

    expect(r.ok).toBe(true);
    if (r.ok) {
      const data = r.result.data as Record<string, unknown>;
      expect(data.forDate).toBe("2026-05-22");
      expect(Array.isArray(data.meetings)).toBe(true);
      expect((data.meetings as unknown[]).length).toBe(1);
      expect(data.displayName).toBe("Anish");
      expect(data.memoryEmpty).toBe(true); // memory.recall(user.voice) returned null
    }
  });

  it("returns skipped when toolRegistry is unavailable", async () => {
    const handle = makeMockDb({ priorSnapshotHash: null });
    const tool = getTool(
      createComposeTools(makeDeps(handle, { toolRegistry: null })),
      "compose.day_context",
    );
    const r = await tool.handler({ forDate: "2026-05-22" }, ctx());
    expect(r.ok).toBe(true);
    if (r.ok) {
      const data = r.result.data as Record<string, unknown>;
      expect(data.skipped).toBe(true);
      expect(data.reason).toBe("tool_registry_unavailable");
    }
  });
});

// ─── compose.maybe_create_task tests ────────────────────────────

// Mock @boringos/agent before importing the tool — vi.hoisted ensures
// the mock is in place by the time createComposeTools is loaded.
const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("@boringos/agent", () => ({ invoke: invokeMock }));

// Mock the compose_hash module so we can control what hash is "current".
const { computeStateHashMock } = vi.hoisted(() => ({
  computeStateHashMock: vi.fn(),
}));
vi.mock("../src/services/compose_hash.js", async () => {
  const actual = await vi.importActual<typeof import("../src/services/compose_hash.js")>(
    "../src/services/compose_hash.js",
  );
  return { ...actual, computeStateHash: computeStateHashMock };
});

// v0.4.54 — mock the day_signal module so compose.day_context tests
// don't need a real DB. Day signal is a pure aggregation service.
const { computeDaySignalMock } = vi.hoisted(() => ({
  computeDaySignalMock: vi.fn(),
}));
vi.mock("../src/services/day_signal.js", async () => {
  const actual = await vi.importActual<typeof import("../src/services/day_signal.js")>(
    "../src/services/day_signal.js",
  );
  return { ...actual, computeDaySignal: computeDaySignalMock };
});

function ctx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    tenantId: "00000000-0000-0000-0000-000000000001",
    invokedBy: "routine",
    ...overrides,
  };
}

interface MockDbHandle {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any;
  calls: {
    select: number;
    insertAwaited: number;
    insertValues: unknown[];
    execute: number;
  };
}

function makeMockDb(opts: {
  priorSnapshotHash?: string | null;
  agentRowsForExecute?: Array<{ id: string }>;
  // v0.4.41: compose.maybe_create_task now runs an inflight-task pre-check
  // via execute() BEFORE the agent lookup. Mock returns inflight rows first,
  // then agent rows, in that order.
  inflightTasksForExecute?: Array<{ id: string }>;
} = {}): MockDbHandle {
  const calls = {
    select: 0,
    insertAwaited: 0,
    insertValues: [] as unknown[],
    execute: 0,
  };

  const finalSelect = () => ({
    limit: async () => {
      calls.select++;
      if (opts.priorSnapshotHash === undefined) return [];
      return [{ stateHash: opts.priorSnapshotHash }];
    },
    orderBy: () => finalSelect(),
  });

  // Queue of execute responses, in code order: inflight check, then agent lookup.
  const executeQueue: unknown[] = [
    opts.inflightTasksForExecute ?? [],
    opts.agentRowsForExecute ?? [],
  ];

  const db = {
    select: () => ({
      from: () => ({
        where: () => ({
          ...finalSelect(),
          orderBy: () => finalSelect(),
        }),
      }),
    }),
    execute: async () => {
      calls.execute++;
      return executeQueue.shift() ?? [];
    },
    insert: () => ({
      values: (v: unknown) => {
        calls.insertValues.push(v);
        const p = Promise.resolve(undefined);
        return {
          returning: async () => [],
          then: (resolve: any, reject: any) => {
            calls.insertAwaited++;
            return p.then(resolve, reject);
          },
        };
      },
    }),
  };
  return { db, calls };
}

function makeDeps(handle: MockDbHandle, opts: { toolRegistry?: unknown } = {}) {
  return {
    db: handle.db,
    getEventBus: () => null,
    toolRegistry: opts.toolRegistry === undefined ? ({} as unknown) : opts.toolRegistry,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

function getTool(tools: { name: string }[], name: string) {
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`tool ${name} not found`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return t as any;
}

describe("compose.maybe_create_task", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    computeStateHashMock.mockReset();
  });
  afterEach(() => {
    invokeMock.mockReset();
    computeStateHashMock.mockReset();
  });

  it("returns skipped=true when tool registry is unavailable", async () => {
    const handle = makeMockDb();
    const tool = getTool(
      createComposeTools(makeDeps(handle, { toolRegistry: null })),
      "compose.maybe_create_task",
    );
    const r = await tool.handler({}, ctx());
    expect(r.ok).toBe(true);
    expect(r.result.data.skipped).toBe(true);
    expect(r.result.data.reason).toBe("tool_registry_unavailable");
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("returns skipped=true with reason=state_unchanged when hashes match", async () => {
    computeStateHashMock.mockResolvedValueOnce("HASH_X");
    const handle = makeMockDb({ priorSnapshotHash: "HASH_X" });
    const tool = getTool(createComposeTools(makeDeps(handle)), "compose.maybe_create_task");

    const r = await tool.handler({ forDate: "2026-05-15" }, ctx());
    expect(r.ok).toBe(true);
    expect(r.result.data.skipped).toBe(true);
    expect(r.result.data.reason).toBe("state_unchanged");
    expect(r.result.data.hash).toBe("HASH_X");
    // No invoke. No insert.
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("creates a task via framework.tasks.create when hashes differ", async () => {
    computeStateHashMock.mockResolvedValueOnce("HASH_NEW");
    const handle = makeMockDb({
      priorSnapshotHash: "HASH_OLD",
      agentRowsForExecute: [{ id: "agent-uuid-1" }],
    });
    // v0.4.39: framework.tasks.create returns `{ id, wake }` flat in
    // `result` — NOT wrapped in `result.data`. EA reads result.id.
    invokeMock.mockResolvedValueOnce({
      ok: true,
      result: { id: "task-uuid-1", wake: undefined },
    });
    // v0.4.55: maybe_create_task ALSO fires compose.prepare_meeting_briefs
    // server-side after the day-brief task lands. Mock that response too.
    invokeMock.mockResolvedValueOnce({
      ok: true,
      result: { data: { created: true, meetingCount: 0 } },
    });

    const tool = getTool(createComposeTools(makeDeps(handle)), "compose.maybe_create_task");
    const r = await tool.handler({ forDate: "2026-05-15" }, ctx());

    expect(r.ok).toBe(true);
    expect(r.result.data.created).toBe(true);
    expect(r.result.data.taskId).toBe("task-uuid-1");
    expect(r.result.data.hashChanged).toBe(true);
    expect(r.result.data.priorHash).toBe("HASH_OLD");
    expect(r.result.data.hash).toBe("HASH_NEW");

    // v0.4.55: two invokes now — the day-brief task create, then the
    // briefer-task spawn.
    expect(invokeMock).toHaveBeenCalledTimes(2);
    const [, toolName, inputs] = invokeMock.mock.calls[0]!;
    expect(toolName).toBe("framework.tasks.create");
    expect(inputs.assigneeAgentId).toBe("agent-uuid-1");
    expect(inputs.title).toBe("Recompose dossier — state changed");
    expect(inputs.originKind).toBe("agent-compose-refresh");
    // v0.4.39: refresh case uses forDate:hash8 as originId so concurrent
    // ticks for the same state dedup, but a real state change re-opens.
    expect(inputs.originId).toBe("2026-05-15:HASH_NEW");
  });

  // v0.4.55 — after creating the day-brief task, ALSO spawn the
  // per-meeting briefer tasks server-side. Day-composer SKILL.md no
  // longer needs a "spawn briefers" step (haiku consistently stopped
  // before reaching it in v0.4.54).
  it("ALSO invokes compose.prepare_meeting_briefs after creating the day-brief task (v0.4.55)", async () => {
    computeStateHashMock.mockResolvedValueOnce("HASH_NEW_55");
    const handle = makeMockDb({
      priorSnapshotHash: "HASH_OLD",
      agentRowsForExecute: [{ id: "agent-uuid-55" }],
    });
    // First invoke is framework.tasks.create, second is the briefer spawn.
    invokeMock.mockResolvedValueOnce({
      ok: true,
      result: { id: "day-task-uuid-55", wake: undefined },
    });
    invokeMock.mockResolvedValueOnce({
      ok: true,
      result: { data: { created: true, taskIds: ["m1", "m2"], meetingCount: 2 } },
    });

    const tool = getTool(createComposeTools(makeDeps(handle)), "compose.maybe_create_task");
    const r = await tool.handler({ forDate: "2026-05-22" }, ctx());

    expect(r.ok).toBe(true);
    expect(invokeMock).toHaveBeenCalledTimes(2);
    expect(invokeMock.mock.calls[0]?.[1]).toBe("framework.tasks.create");
    expect(invokeMock.mock.calls[1]?.[1]).toBe(
      "executive-assistant.compose.prepare_meeting_briefs",
    );
  });

  it("creates the first-compose task when no prior snapshot exists (null priorHash)", async () => {
    computeStateHashMock.mockResolvedValueOnce("HASH_FIRST");
    const handle = makeMockDb({
      // priorSnapshotHash: undefined → select returns []
      agentRowsForExecute: [{ id: "agent-uuid-1" }],
    });
    // v0.4.39: flat `{ id, wake }` shape.
    invokeMock.mockResolvedValueOnce({
      ok: true,
      result: { id: "task-uuid-first", wake: undefined },
    });
    // v0.4.55: also the briefer spawn invoke.
    invokeMock.mockResolvedValueOnce({
      ok: true,
      result: { data: { created: true, meetingCount: 0 } },
    });

    const tool = getTool(createComposeTools(makeDeps(handle)), "compose.maybe_create_task");
    const r = await tool.handler({ forDate: "2026-05-15" }, ctx());

    expect(r.ok).toBe(true);
    expect(r.result.data.created).toBe(true);
    expect(r.result.data.taskId).toBe("task-uuid-first");
    expect(r.result.data.priorHash).toBeNull();
    expect(r.result.data.hash).toBe("HASH_FIRST");

    const [, toolName, inputs] = invokeMock.mock.calls[0]!;
    expect(toolName).toBe("framework.tasks.create");
    expect(inputs.title).toBe("Compose morning dossier");
    expect(inputs.originKind).toBe("agent-morning-compose");
    // v0.4.39: first-compose uses forDate alone (one compose per day).
    expect(inputs.originId).toBe("2026-05-15");
  });

  // v0.4.41 — Fix A: pre-check prevents duplicate compose tasks when
  // install hook + UI mount + cron all fire within seconds of each other,
  // before any snapshot has been written to hash-guard against.
  it("returns skipped=task_inflight when a matching task is already in flight", async () => {
    computeStateHashMock.mockResolvedValueOnce("HASH_FIRST");
    const handle = makeMockDb({
      // No prior snapshot → would normally proceed to create a task.
      inflightTasksForExecute: [{ id: "existing-inflight-task-uuid" }],
    });

    const tool = getTool(createComposeTools(makeDeps(handle)), "compose.maybe_create_task");
    const r = await tool.handler({ forDate: "2026-05-15" }, ctx());

    expect(r.ok).toBe(true);
    expect(r.result.data.skipped).toBe(true);
    expect(r.result.data.reason).toBe("task_inflight");
    expect(r.result.data.taskId).toBe("existing-inflight-task-uuid");
    // No agent lookup, no task creation — short-circuit.
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("skips with reason=ea_agent_missing when the EA agent isn't seeded", async () => {
    computeStateHashMock.mockResolvedValueOnce("HASH_DIFFERS");
    const handle = makeMockDb({
      priorSnapshotHash: "HASH_OLD",
      agentRowsForExecute: [], // no agent rows → tenant without Claude runtime
    });

    const tool = getTool(createComposeTools(makeDeps(handle)), "compose.maybe_create_task");
    const r = await tool.handler({ forDate: "2026-05-15" }, ctx());

    expect(r.ok).toBe(true);
    expect(r.result.data.skipped).toBe(true);
    expect(r.result.data.reason).toBe("ea_agent_missing");
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("returns internal error if compose_hash throws", async () => {
    computeStateHashMock.mockRejectedValueOnce(new Error("db boom"));
    const handle = makeMockDb({ priorSnapshotHash: "HASH_OLD" });
    const tool = getTool(createComposeTools(makeDeps(handle)), "compose.maybe_create_task");
    const r = await tool.handler({}, ctx());
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("internal");
      expect(r.error.message).toMatch(/state hash failed: db boom/);
    }
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("defaults forDate to today (host clock) when input.forDate is absent", async () => {
    computeStateHashMock.mockResolvedValueOnce("ANY");
    const handle = makeMockDb({ priorSnapshotHash: "ANY" });
    const tool = getTool(createComposeTools(makeDeps(handle)), "compose.maybe_create_task");
    const r = await tool.handler({}, ctx());
    expect(r.ok).toBe(true);
    expect(r.result.data.forDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // And the date passed to computeStateHash must match.
    const [, , forDate] = computeStateHashMock.mock.calls[0]!;
    expect(forDate).toBe(r.result.data.forDate);
  });
});
