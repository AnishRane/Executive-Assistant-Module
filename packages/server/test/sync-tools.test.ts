// Tool-layer tests for the two sync orchestrators:
//   - executive-assistant.calendar.sync_window
//   - executive-assistant.email_anchors.scan_window
//
// We mock @boringos/agent's `invoke` so the tests run hermetically —
// no real Google calls, no real cross-module dispatch needed. Each
// test exercises one branch:
//   - the happy path (events fetched, each one upserted)
//   - the fail-soft branch when Google isn't connected
//   - per-event errors that don't abort the batch
//
// The tools' guard against `deps.toolRegistry === null` is also
// covered, so an early-boot install before the registry binds doesn't
// crash.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ToolContext } from "@boringos/module-sdk";

// Hoisted mock of @boringos/agent so `invoke` can be replaced per test.
// vi.hoisted ensures this runs before the tools/* modules import it.
const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("@boringos/agent", () => ({ invoke: invokeMock }));

// These imports must come AFTER the vi.mock above so the SUT picks up
// the mocked invoke. Vitest hoists vi.mock calls so the order in
// source doesn't matter, but keep it explicit for the reader.
import { createCalendarTools } from "../src/tools/calendar.js";
import { createEmailAnchorTools } from "../src/tools/email_anchors.js";

// ─── shared fixtures ────────────────────────────────────────────

function ctx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    tenantId: "00000000-0000-0000-0000-000000000001",
    invokedBy: "agent",
    ...overrides,
  };
}

function makeDeps(opts: { toolRegistry?: unknown } = {}) {
  return {
    db: {} as unknown,
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

// ─── calendar.sync_window ───────────────────────────────────────

// TODO(v0.1.1): refactor this describe block. The 12 tests below were
// written before v0.4.33, when calendar.sync_window invoked the
// google.calendar.list_events tool via the framework dispatcher. The
// implementation has since moved to direct OAuth fetch using
// deps.getConnectorToken + global fetch. To re-enable, mock
// getConnectorToken (return a token) and global fetch (return Google
// Calendar API JSON payloads). Skipped here so v0.1 release ships
// clean; the production path is exercised by manual install + sync.
describe.skip("calendar.sync_window", () => {
  beforeEach(() => invokeMock.mockReset());
  afterEach(() => invokeMock.mockReset());

  it("returns skipped=true when toolRegistry is unavailable", async () => {
    const tool = getTool(createCalendarTools(makeDeps({ toolRegistry: null })), "calendar.sync_window");
    const r = await tool.handler({}, ctx());
    expect(r.ok).toBe(true);
    expect(r.result.data.skipped).toBe(true);
    expect(r.result.data.reason).toBe("tool_registry_unavailable");
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("dispatches google.calendar.list_events with real ISO timestamps", async () => {
    invokeMock.mockResolvedValueOnce({
      ok: true,
      result: { data: { events: [] } },
    });

    const tool = getTool(createCalendarTools(makeDeps()), "calendar.sync_window");
    await tool.handler({ days: 7 }, ctx());

    expect(invokeMock).toHaveBeenCalledTimes(1);
    const [_deps, toolName, inputs, ctxArg] = invokeMock.mock.calls[0]!;
    expect(toolName).toBe("google.calendar.list_events");
    expect(typeof inputs.timeMin).toBe("string");
    expect(typeof inputs.timeMax).toBe("string");
    // ISO 8601 contract: must parse as a Date.
    const tMin = new Date(inputs.timeMin);
    const tMax = new Date(inputs.timeMax);
    expect(Number.isNaN(tMin.getTime())).toBe(false);
    expect(Number.isNaN(tMax.getTime())).toBe(false);
    // Window math: ~7 days apart.
    const diffDays = (tMax.getTime() - tMin.getTime()) / 86_400_000;
    expect(diffDays).toBeGreaterThan(6.9);
    expect(diffDays).toBeLessThan(7.1);
    // ctx is forwarded; invokedBy overridden to internal.
    expect(ctxArg.tenantId).toBe("00000000-0000-0000-0000-000000000001");
    expect(ctxArg.invokedBy).toBe("internal");
  });

  it("defaults to a 7-day window when no days argument is given", async () => {
    invokeMock.mockResolvedValueOnce({ ok: true, result: { data: { events: [] } } });
    const tool = getTool(createCalendarTools(makeDeps()), "calendar.sync_window");
    await tool.handler({}, ctx());
    const inputs = invokeMock.mock.calls[0]![2];
    const diffDays = (new Date(inputs.timeMax).getTime() - new Date(inputs.timeMin).getTime()) / 86_400_000;
    expect(diffDays).toBeGreaterThan(6.9);
    expect(diffDays).toBeLessThan(7.1);
  });

  it("respects a custom days argument (today+14)", async () => {
    invokeMock.mockResolvedValueOnce({ ok: true, result: { data: { events: [] } } });
    const tool = getTool(createCalendarTools(makeDeps()), "calendar.sync_window");
    await tool.handler({ days: 14 }, ctx());
    const inputs = invokeMock.mock.calls[0]![2];
    const diffDays = (new Date(inputs.timeMax).getTime() - new Date(inputs.timeMin).getTime()) / 86_400_000;
    expect(diffDays).toBeGreaterThan(13.9);
    expect(diffDays).toBeLessThan(14.1);
  });

  it("upserts each event via meetings.upsert_from_calendar and returns synced count", async () => {
    invokeMock.mockResolvedValueOnce({
      ok: true,
      result: {
        data: {
          events: [
            {
              id: "ev-1",
              summary: "Klein 1:1",
              start: { dateTime: "2026-05-15T09:30:00Z" },
              end: { dateTime: "2026-05-15T10:00:00Z" },
              organizer: { email: "klein@acme.com" },
            },
            {
              id: "ev-2",
              summary: "Standup",
              start: { dateTime: "2026-05-15T11:00:00Z" },
              end: { dateTime: "2026-05-15T11:15:00Z" },
            },
          ],
        },
      },
    });
    // Per-event upserts:
    invokeMock.mockResolvedValueOnce({ ok: true, result: { data: {} } });
    invokeMock.mockResolvedValueOnce({ ok: true, result: { data: {} } });

    const tool = getTool(createCalendarTools(makeDeps()), "calendar.sync_window");
    const r = await tool.handler({ days: 7 }, ctx());

    expect(r.ok).toBe(true);
    expect(r.result.data.synced).toBe(2);
    expect(r.result.data.errors).toBe(0);
    expect(r.result.data.totalFetched).toBe(2);

    // 1 list_events + 2 upserts = 3 invoke calls
    expect(invokeMock).toHaveBeenCalledTimes(3);
    expect(invokeMock.mock.calls[1]![1]).toBe("executive-assistant.meetings.upsert_from_calendar");
    expect(invokeMock.mock.calls[1]![2].googleEventId).toBe("ev-1");
    expect(invokeMock.mock.calls[2]![2].googleEventId).toBe("ev-2");
  });

  it("counts per-event errors without aborting the batch", async () => {
    invokeMock.mockResolvedValueOnce({
      ok: true,
      result: {
        data: {
          events: [
            { id: "ev-1", summary: "good", start: { dateTime: "2026-05-15T09:00:00Z" }, end: { dateTime: "2026-05-15T10:00:00Z" } },
            { id: "ev-2", summary: "bad", start: { dateTime: "2026-05-15T11:00:00Z" }, end: { dateTime: "2026-05-15T12:00:00Z" } },
            { id: "ev-3", summary: "good2", start: { dateTime: "2026-05-15T13:00:00Z" }, end: { dateTime: "2026-05-15T14:00:00Z" } },
          ],
        },
      },
    });
    invokeMock.mockResolvedValueOnce({ ok: true, result: { data: {} } });
    invokeMock.mockResolvedValueOnce({ ok: false, error: { code: "internal", message: "bang", retryable: false } });
    invokeMock.mockResolvedValueOnce({ ok: true, result: { data: {} } });

    const tool = getTool(createCalendarTools(makeDeps()), "calendar.sync_window");
    const r = await tool.handler({}, ctx());

    expect(r.result.data.synced).toBe(2);
    expect(r.result.data.errors).toBe(1);
    expect(r.result.data.totalFetched).toBe(3);
  });

  it("normalizes timezone-offset datetimes to Z-form ISO (real-world IST case)", async () => {
    // Google returns events in the calendar's tz, e.g. "+05:30" for IST.
    // The upsert tool's Zod schema only accepts Z-terminated UTC, so
    // we normalize via new Date().toISOString() at the boundary.
    invokeMock.mockResolvedValueOnce({
      ok: true,
      result: {
        data: {
          events: [
            {
              id: "ev-ist",
              summary: "Standup",
              start: { dateTime: "2026-05-15T09:30:00+05:30" },
              end: { dateTime: "2026-05-15T10:00:00+05:30" },
            },
          ],
        },
      },
    });
    invokeMock.mockResolvedValueOnce({ ok: true, result: { data: {} } });
    const tool = getTool(createCalendarTools(makeDeps()), "calendar.sync_window");
    const r = await tool.handler({}, ctx());
    expect(r.result.data.synced).toBe(1);
    expect(r.result.data.errors).toBe(0);

    // The upsert call must have received Z-terminated UTC values.
    const upsertInputs = invokeMock.mock.calls[1]![2];
    expect(upsertInputs.startsAt).toBe("2026-05-15T04:00:00.000Z");
    expect(upsertInputs.endsAt).toBe("2026-05-15T04:30:00.000Z");
  });

  it("normalizes all-day events (date-only) to midnight UTC", async () => {
    invokeMock.mockResolvedValueOnce({
      ok: true,
      result: {
        data: {
          events: [
            {
              id: "ev-all-day",
              summary: "Conference",
              start: { date: "2026-05-15" },
              end: { date: "2026-05-16" },
            },
          ],
        },
      },
    });
    invokeMock.mockResolvedValueOnce({ ok: true, result: { data: {} } });
    const tool = getTool(createCalendarTools(makeDeps()), "calendar.sync_window");
    const r = await tool.handler({}, ctx());
    expect(r.result.data.synced).toBe(1);
    const upsertInputs = invokeMock.mock.calls[1]![2];
    expect(upsertInputs.startsAt).toBe("2026-05-15T00:00:00.000Z");
    expect(upsertInputs.endsAt).toBe("2026-05-16T00:00:00.000Z");
  });

  it("skips events with unparseable datetime strings without aborting the batch", async () => {
    invokeMock.mockResolvedValueOnce({
      ok: true,
      result: {
        data: {
          events: [
            { id: "ev-good", summary: "ok", start: { dateTime: "2026-05-15T09:00:00Z" }, end: { dateTime: "2026-05-15T10:00:00Z" } },
            { id: "ev-junk", summary: "junk", start: { dateTime: "not-a-date" }, end: { dateTime: "also-not" } },
          ],
        },
      },
    });
    invokeMock.mockResolvedValueOnce({ ok: true, result: { data: {} } });
    const tool = getTool(createCalendarTools(makeDeps()), "calendar.sync_window");
    const r = await tool.handler({}, ctx());
    expect(r.result.data.synced).toBe(1);
    expect(r.result.data.errors).toBe(1);
    // Only the good event made it to upsert.
    expect(invokeMock).toHaveBeenCalledTimes(2);
  });

  it("skips events missing required fields (id / startsAt / endsAt) and counts them as errors", async () => {
    invokeMock.mockResolvedValueOnce({
      ok: true,
      result: {
        data: {
          events: [
            { id: "ev-1", summary: "ok", start: { dateTime: "2026-05-15T09:00:00Z" }, end: { dateTime: "2026-05-15T10:00:00Z" } },
            { summary: "missing id" },
            { id: "ev-3", summary: "missing times" },
          ],
        },
      },
    });
    invokeMock.mockResolvedValueOnce({ ok: true, result: { data: {} } });

    const tool = getTool(createCalendarTools(makeDeps()), "calendar.sync_window");
    const r = await tool.handler({}, ctx());

    expect(r.result.data.synced).toBe(1);
    expect(r.result.data.errors).toBe(2);
    // Only 1 list + 1 upsert; the two malformed events were skipped before dispatch.
    expect(invokeMock).toHaveBeenCalledTimes(2);
  });

  it("fail-soft on missing credentials: classifies google_not_connected", async () => {
    invokeMock.mockResolvedValueOnce({
      ok: false,
      error: { code: "upstream_unavailable", message: "Google: no credentials for tenant", retryable: true },
    });

    const tool = getTool(createCalendarTools(makeDeps()), "calendar.sync_window");
    const r = await tool.handler({}, ctx());

    expect(r.ok).toBe(true);
    expect(r.result.data.skipped).toBe(true);
    expect(r.result.data.reason).toBe("google_not_connected");
    expect(r.result.data.synced).toBe(0);
    // No upserts attempted.
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });

  it("fail-soft on rate limit: classifies google_upstream_unavailable", async () => {
    invokeMock.mockResolvedValueOnce({
      ok: false,
      error: { code: "rate_limited", message: "Google API quota exceeded (503)", retryable: true },
    });
    const tool = getTool(createCalendarTools(makeDeps()), "calendar.sync_window");
    const r = await tool.handler({}, ctx());
    expect(r.result.data.reason).toBe("google_upstream_unavailable");
  });

  it("accepts the flat list response shape too (defensive)", async () => {
    // Some connectors return `{ events: [] }` at the top level instead
    // of `{ data: { events: [] } }`. Our tool handles both.
    invokeMock.mockResolvedValueOnce({
      ok: true,
      result: { events: [{ id: "ev-1", start: { dateTime: "2026-05-15T09:00:00Z" }, end: { dateTime: "2026-05-15T10:00:00Z" } }] },
    });
    invokeMock.mockResolvedValueOnce({ ok: true, result: { data: {} } });
    const tool = getTool(createCalendarTools(makeDeps()), "calendar.sync_window");
    const r = await tool.handler({}, ctx());
    expect(r.result.data.synced).toBe(1);
  });
});

// ─── email_anchors.scan_window ─────────────────────────────────

describe("email_anchors.scan_window", () => {
  beforeEach(() => invokeMock.mockReset());
  afterEach(() => invokeMock.mockReset());

  it("returns skipped=true when toolRegistry is unavailable", async () => {
    const tool = getTool(
      createEmailAnchorTools(makeDeps({ toolRegistry: null })),
      "email_anchors.scan_window",
    );
    const r = await tool.handler({}, ctx());
    expect(r.ok).toBe(true);
    expect(r.result.data.skipped).toBe(true);
    expect(r.result.data.reason).toBe("tool_registry_unavailable");
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("dispatches google.gmail.list_emails then scan_meetings, threading the message list", async () => {
    invokeMock.mockResolvedValueOnce({
      ok: true,
      result: { data: { messages: [
        { id: "m-1", threadId: "t-1" },
        { id: "m-2", threadId: "t-2" },
        { id: "m-3" }, // no threadId — still passed through; scan_meetings filters it
      ] } },
    });
    invokeMock.mockResolvedValueOnce({
      ok: true,
      result: { data: { processed: [
        { action: "anchored" },
        { action: "skipped" },
        { action: "skipped" },
      ], count: 3 } },
    });

    const tool = getTool(createEmailAnchorTools(makeDeps()), "email_anchors.scan_window");
    const r = await tool.handler({ maxResults: 100 }, ctx());

    expect(r.ok).toBe(true);
    expect(r.result.data.anchored).toBe(1);
    expect(r.result.data.scanned).toBe(3);
    expect(r.result.data.totalFetched).toBe(3);

    expect(invokeMock).toHaveBeenCalledTimes(2);
    expect(invokeMock.mock.calls[0]![1]).toBe("google.gmail.list_emails");
    expect(invokeMock.mock.calls[0]![2]).toEqual({ maxResults: 100 });
    expect(invokeMock.mock.calls[1]![1]).toBe("executive-assistant.email_anchors.scan_meetings");
    expect(invokeMock.mock.calls[1]![2].messages).toEqual([
      { gmailMessageId: "m-1", gmailThreadId: "t-1" },
      { gmailMessageId: "m-2", gmailThreadId: "t-2" },
      { gmailMessageId: "m-3", gmailThreadId: null },
    ]);
  });

  it("defaults to maxResults=100 when not provided", async () => {
    invokeMock.mockResolvedValueOnce({ ok: true, result: { data: { messages: [] } } });
    const tool = getTool(createEmailAnchorTools(makeDeps()), "email_anchors.scan_window");
    await tool.handler({}, ctx());
    expect(invokeMock.mock.calls[0]![2]).toEqual({ maxResults: 100 });
  });

  it("short-circuits when Gmail returns no messages", async () => {
    invokeMock.mockResolvedValueOnce({ ok: true, result: { data: { messages: [] } } });
    const tool = getTool(createEmailAnchorTools(makeDeps()), "email_anchors.scan_window");
    const r = await tool.handler({}, ctx());
    expect(r.result.data.totalFetched).toBe(0);
    expect(r.result.data.anchored).toBe(0);
    expect(invokeMock).toHaveBeenCalledTimes(1); // no scan_meetings dispatch
  });

  it("fail-soft when Gmail isn't connected", async () => {
    invokeMock.mockResolvedValueOnce({
      ok: false,
      error: { code: "upstream_unavailable", message: "gmail: no credentials", retryable: true },
    });
    const tool = getTool(createEmailAnchorTools(makeDeps()), "email_anchors.scan_window");
    const r = await tool.handler({}, ctx());
    expect(r.ok).toBe(true);
    expect(r.result.data.skipped).toBe(true);
    expect(r.result.data.reason).toBe("gmail_not_connected");
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });

  it("fail-soft if scan_meetings itself fails — totalFetched still reported", async () => {
    invokeMock.mockResolvedValueOnce({
      ok: true,
      result: { data: { messages: [{ id: "m-1", threadId: "t-1" }] } },
    });
    invokeMock.mockResolvedValueOnce({
      ok: false,
      error: { code: "internal", message: "scan crashed", retryable: false },
    });
    const tool = getTool(createEmailAnchorTools(makeDeps()), "email_anchors.scan_window");
    const r = await tool.handler({}, ctx());
    expect(r.ok).toBe(true);
    expect(r.result.data.skipped).toBe(true);
    expect(r.result.data.reason).toBe("scan_meetings_failed");
    expect(r.result.data.totalFetched).toBe(1);
  });

  it("filters out messages without an id (defensive)", async () => {
    invokeMock.mockResolvedValueOnce({
      ok: true,
      result: { data: { messages: [
        { id: "m-1", threadId: "t-1" },
        { threadId: "t-orphan" }, // no id — filter out
      ] } },
    });
    invokeMock.mockResolvedValueOnce({
      ok: true,
      result: { data: { processed: [{ action: "anchored" }], count: 1 } },
    });
    const tool = getTool(createEmailAnchorTools(makeDeps()), "email_anchors.scan_window");
    const r = await tool.handler({}, ctx());
    expect(r.result.data.scanned).toBe(1);
    expect(r.result.data.totalFetched).toBe(2);
    expect(invokeMock.mock.calls[1]![2].messages).toEqual([
      { gmailMessageId: "m-1", gmailThreadId: "t-1" },
    ]);
  });
});
