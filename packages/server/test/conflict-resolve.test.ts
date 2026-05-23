// v0.4.16: conflicts.resolve now supports a "both skipped" path —
// when the user reports they attended neither side of a conflicted
// pair. Captured as a distinct feedback signal so the reflection
// step can tell "user prefers X over Y" from "user attended neither".

import { describe, it, expect, vi, beforeEach as viBeforeEach } from "vitest";
import type { ToolContext } from "@boringos/module-sdk";

const { writeFeedbackMock } = vi.hoisted(() => ({ writeFeedbackMock: vi.fn() }));
vi.mock("../src/services/feedback.js", () => ({
  writeFeedback: writeFeedbackMock,
  summariseDiff: vi.fn(),
}));

import { createConflictTools } from "../src/tools/conflicts.js";

function ctx(): ToolContext {
  return { tenantId: "00000000-0000-0000-0000-000000000001", invokedBy: "user" };
}

const FAKE_CONFLICT = {
  id: "c1",
  tenantId: ctx().tenantId,
  forDate: "2026-05-16",
  refAKind: "meeting",
  refAId: "11111111-1111-1111-1111-111111111111",
  refBKind: "meeting",
  refBId: "22222222-2222-2222-2222-222222222222",
  overlapMinutes: 30,
  resolutionStatus: "unresolved",
};

// Thenable chain that resolves to whatever rows are sequenced for each
// .select() call. Mirrors the pattern in meetings-localized.test.ts.
class Chain {
  constructor(private rows: unknown[]) {}
  from() { return this; }
  where() { return this; }
  limit() { return this; }
  set() { return this; }
  returning() { return Promise.resolve(this.rows); }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  then(ok: any, err: any) { return Promise.resolve(this.rows).then(ok, err); }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeDeps(callResults: unknown[][]): any {
  let idx = 0;
  return {
    db: {
      select: () => new Chain(callResults[idx++] ?? []),
      update: () => new Chain(callResults[idx++] ?? []),
    },
    getEventBus: () => null,
    toolRegistry: null,
  };
}

function tool(deps: ReturnType<typeof makeDeps>) {
  const t = createConflictTools(deps).find((x) => x.name === "conflicts.resolve");
  if (!t) throw new Error("conflicts.resolve tool not found");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return t as any;
}

describe("conflicts.resolve — pick-one-side (existing behaviour)", () => {
  viBeforeEach(() => writeFeedbackMock.mockReset());

  it("returns resolved_by_user with the chosen ref id when user picks a side", async () => {
    writeFeedbackMock.mockResolvedValue(undefined);
    const deps = makeDeps([
      [FAKE_CONFLICT],
      [{ ...FAKE_CONFLICT, resolutionStatus: "resolved_by_user", resolvedChoice: FAKE_CONFLICT.refAId }],
    ]);
    const r = await tool(deps).handler(
      { id: "c1", chosenRefId: FAKE_CONFLICT.refAId },
      ctx(),
    );
    expect(r.ok).toBe(true);
    expect(writeFeedbackMock).toHaveBeenCalledTimes(1);
    expect(writeFeedbackMock.mock.calls[0]![1]).toMatchObject({
      signalKind: "conflict_resolved",
      value: expect.objectContaining({
        chosenRefId: FAKE_CONFLICT.refAId,
        deprioritisedRefId: FAKE_CONFLICT.refBId,
      }),
    });
  });
});

describe("conflicts.resolve — both-skipped (v0.4.16 new path)", () => {
  viBeforeEach(() => writeFeedbackMock.mockReset());

  it("when chosenRefId is omitted, records resolved_by_user with null choice and emits conflict_both_skipped", async () => {
    writeFeedbackMock.mockResolvedValue(undefined);
    const deps = makeDeps([
      [FAKE_CONFLICT],
      [{ ...FAKE_CONFLICT, resolutionStatus: "resolved_by_user", resolvedChoice: null }],
    ]);
    const r = await tool(deps).handler({ id: "c1" }, ctx());
    expect(r.ok).toBe(true);
    expect(writeFeedbackMock).toHaveBeenCalledTimes(1);
    const fed = writeFeedbackMock.mock.calls[0]![1];
    expect(fed.signalKind).toBe("conflict_both_skipped");
    expect(fed.value).toMatchObject({
      refAId: FAKE_CONFLICT.refAId,
      refBId: FAKE_CONFLICT.refBId,
    });
  });
});

describe("conflicts.resolve — validation", () => {
  viBeforeEach(() => writeFeedbackMock.mockReset());

  it("returns invalid_input when chosenRefId is set but doesn't match either side", async () => {
    const deps = makeDeps([[FAKE_CONFLICT]]);
    const r = await tool(deps).handler(
      { id: "c1", chosenRefId: "99999999-9999-9999-9999-999999999999" },
      ctx(),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("invalid_input");
  });
});

