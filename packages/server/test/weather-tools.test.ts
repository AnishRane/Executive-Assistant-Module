// Tool-layer tests for the three weather tools — exercise the
// upsert branching, the upstream-failure mapping, and the
// dismiss → feedback-signal kind translation. Mirrors the mock-db
// pattern used by reconciler.test.ts but extends it to:
//
//   - distinguish select/orderBy chains (get_for_snapshot)
//   - support insert().values() awaited directly (writeFeedback's
//     no-returning path) AS WELL AS insert().values().returning()
//     (fetch_for_date's upsert path)
//
// The real db's contract is the partial unique index on
// (tenant_id, for_date, location_label). Here we verify the *branch*
// logic in the tool — the index is the authoritative dedup.

import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
} from "vitest";
import type { ToolContext } from "@boringos/module-sdk";
import { createWeatherTools } from "../src/tools/weather.js";

// ─── Mock db ─────────────────────────────────────────────────────

interface MockDbOpts {
  // First select call's result (typically: row[] returned).
  selectResults?: unknown[][];
  insertReturning?: unknown[];
  updateReturning?: unknown[];
}

interface MockDbHandle {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any;
  calls: {
    select: number;
    insertValues: unknown[];
    insertReturning: number;
    insertAwaited: number;
    updateValues: unknown[];
    update: number;
  };
}

function makeMockDb(opts: MockDbOpts = {}): MockDbHandle {
  const selectResults = opts.selectResults ?? [];
  let selectCallIdx = 0;

  const calls = {
    select: 0,
    insertValues: [] as unknown[],
    insertReturning: 0,
    insertAwaited: 0,
    updateValues: [] as unknown[],
    update: 0,
  };

  // Each chain ends at .limit() (which is await-able). For
  // get_for_snapshot the chain is .where().orderBy().limit() so we
  // need orderBy() to also return something with .limit().
  const finalSelect = () => ({
    limit: async () => {
      calls.select++;
      const r = selectResults[selectCallIdx] ?? [];
      selectCallIdx++;
      return r;
    },
  });

  const db = {
    select: () => ({
      from: () => ({
        where: () => ({
          ...finalSelect(),
          orderBy: () => finalSelect(),
        }),
      }),
    }),

    insert: () => ({
      values: (v: unknown) => {
        calls.insertValues.push(v);
        const promise = Promise.resolve(undefined);
        const obj: PromiseLike<unknown> & {
          returning: () => Promise<unknown[]>;
        } = {
          returning: async () => {
            calls.insertReturning++;
            return opts.insertReturning ?? [];
          },
          // Awaiting values() directly (writeFeedback's path) returns
          // undefined — we just want to know it was awaited.
          then: (resolve, reject) => {
            calls.insertAwaited++;
            return promise.then(resolve, reject);
          },
        };
        return obj;
      },
    }),

    update: () => ({
      set: (v: unknown) => {
        calls.updateValues.push(v);
        return {
          where: () => ({
            returning: async () => {
              calls.update++;
              return opts.updateReturning ?? [];
            },
          }),
        };
      },
    }),
  };

  return { db, calls };
}

// ─── ToolContext + stubbed fetch helpers ─────────────────────────

function ctx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    tenantId: "00000000-0000-0000-0000-000000000001",
    invokedBy: "agent",
    ...overrides,
  };
}

function stubOpenMeteoOk(forDate: string) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({
        daily: {
          time: [forDate],
          weather_code: [65], // → Heavy rain
          temperature_2m_max: [18],
          temperature_2m_min: [11],
          apparent_temperature_max: [16],
          apparent_temperature_min: [8],
          precipitation_sum: [22.4],
          precipitation_probability_max: [95],
          wind_speed_10m_max: [38],
          wind_gusts_10m_max: [62],
          uv_index_max: [2],
          sunrise: [`${forDate}T05:42`],
          sunset: [`${forDate}T20:11`],
        },
      }),
    })) as unknown as typeof fetch,
  );
}

function stubOpenMeteoFail() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: false,
      status: 503,
      statusText: "Service Unavailable",
      json: async () => ({}),
    })) as unknown as typeof fetch,
  );
}

const deps = (db: unknown) =>
  ({ db, getEventBus: () => null }) as unknown as Parameters<
    typeof createWeatherTools
  >[0];

function buildToolBound(name: string, db: unknown) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tool = createWeatherTools(deps(db) as any).find((t) => t.name === name);
  if (!tool) throw new Error(`tool ${name} not found`);
  return tool;
}

// ─── Tool: weather.fetch_for_date ───────────────────────────────

describe("weather.fetch_for_date", () => {
  beforeEach(() => vi.unstubAllGlobals());
  afterEach(() => vi.unstubAllGlobals());

  it("INSERTs when no existing row matches (tenant, date, location)", async () => {
    stubOpenMeteoOk("2026-05-14");
    const inserted = { id: "weather-1" };
    const { db, calls } = makeMockDb({
      selectResults: [[]], // no existing row
      insertReturning: [inserted],
    });
    const tool = buildToolBound("weather.fetch_for_date", db);

    const result = await tool.handler(
      {
        forDate: "2026-05-14",
        locationLabel: "London, UK",
        latitude: 51.5074,
        longitude: -0.1278,
        tz: "Europe/London",
      },
      ctx(),
    );

    expect(result.ok).toBe(true);
    expect(calls.select).toBe(1);
    expect(calls.insertReturning).toBe(1);
    expect(calls.update).toBe(0);

    // The inserted values mirror every new field we capture.
    const v = calls.insertValues[0] as Record<string, unknown>;
    expect(v.tenantId).toBe("00000000-0000-0000-0000-000000000001");
    expect(v.locationLabel).toBe("London, UK");
    expect(v.forDate).toBe("2026-05-14");

    expect(v.conditionCode).toBe("rain");
    expect(v.conditionLabel).toBe("Heavy rain");

    expect(v.tempHighC).toBe(18);
    expect(v.tempLowC).toBe(11);
    expect(v.tempApparentHighC).toBe(16);
    expect(v.tempApparentLowC).toBe(8);

    expect(v.precipProbabilityMax).toBe(95);
    expect(v.precipitationMm).toBe(22.4);

    expect(v.windSpeedMaxKmh).toBe(38);
    expect(v.windGustsMaxKmh).toBe(62);

    expect(v.uvIndexMax).toBe(2);

    expect(v.sunrise).toBeInstanceOf(Date);
    expect(v.sunset).toBeInstanceOf(Date);

    expect(typeof v.summary).toBe("string");
    // defaultSummary should weave the granular label + range + precip
    // + gust note in (UV is too low to mention here).
    expect((v.summary as string)).toContain("Heavy rain");
    expect((v.summary as string)).toContain("95% precip");
    expect((v.summary as string)).toContain("62 km/h gusts");
  });

  it("UPDATEs when a row already exists for (tenant, date, location)", async () => {
    stubOpenMeteoOk("2026-05-14");
    const existing = { id: "weather-existing" };
    const updated = { id: "weather-existing", summary: "Heavy rain · 11–18°C" };
    const { db, calls } = makeMockDb({
      selectResults: [[existing]],
      updateReturning: [updated],
    });
    const tool = buildToolBound("weather.fetch_for_date", db);

    const result = await tool.handler(
      {
        forDate: "2026-05-14",
        locationLabel: "London, UK",
        latitude: 51.5074,
        longitude: -0.1278,
        tz: "Europe/London",
      },
      ctx(),
    );

    expect(result.ok).toBe(true);
    expect(calls.select).toBe(1);
    expect(calls.update).toBe(1);
    expect(calls.insertReturning).toBe(0);

    // The update values payload should still carry all the new fields.
    const v = calls.updateValues[0] as Record<string, unknown>;
    expect(v.conditionLabel).toBe("Heavy rain");
    expect(v.tempApparentHighC).toBe(16);
    expect(v.windGustsMaxKmh).toBe(62);
  });

  it("uses a caller-provided summary verbatim when given", async () => {
    stubOpenMeteoOk("2026-05-14");
    const { db, calls } = makeMockDb({
      selectResults: [[]],
      insertReturning: [{ id: "weather-1" }],
    });
    const tool = buildToolBound("weather.fetch_for_date", db);

    await tool.handler(
      {
        forDate: "2026-05-14",
        locationLabel: "London, UK",
        latitude: 51.5074,
        longitude: -0.1278,
        tz: "Europe/London",
        summary: "Wet morning, settles by lunch.",
      },
      ctx(),
    );

    const v = calls.insertValues[0] as Record<string, unknown>;
    expect(v.summary).toBe("Wet morning, settles by lunch.");
  });

  it("returns upstream_unavailable when Open-Meteo fails", async () => {
    stubOpenMeteoFail();
    const { db, calls } = makeMockDb();
    const tool = buildToolBound("weather.fetch_for_date", db);

    const result = await tool.handler(
      {
        forDate: "2026-05-14",
        locationLabel: "London, UK",
        latitude: 51.5074,
        longitude: -0.1278,
        tz: "Europe/London",
      },
      ctx(),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("upstream_unavailable");
      expect(result.error.retryable).toBe(true);
      expect(result.error.message).toMatch(/open-meteo 503/);
    }
    // No db work should have happened.
    expect(calls.select).toBe(0);
    expect(calls.insertReturning).toBe(0);
    expect(calls.update).toBe(0);
  });
});

// ─── Tool: weather.get_for_snapshot ─────────────────────────────

describe("weather.get_for_snapshot", () => {
  it("returns the most recent matching row when one exists", async () => {
    const row = {
      id: "weather-1",
      tenantId: "00000000-0000-0000-0000-000000000001",
      forDate: "2026-05-14",
      locationLabel: "London, UK",
      conditionLabel: "Partly cloudy",
    };
    const { db, calls } = makeMockDb({ selectResults: [[row]] });
    const tool = buildToolBound("weather.get_for_snapshot", db);

    const result = await tool.handler({ forDate: "2026-05-14" }, ctx());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(
        (result.result as { data: unknown }).data,
      ).toEqual(row);
    }
    expect(calls.select).toBe(1);
  });

  it("returns null when no row exists", async () => {
    const { db } = makeMockDb({ selectResults: [[]] });
    const tool = buildToolBound("weather.get_for_snapshot", db);

    const result = await tool.handler({ forDate: "2026-05-14" }, ctx());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(
        (result.result as { data: unknown }).data,
      ).toBeNull();
    }
  });

  it("accepts an optional locationLabel filter without changing the response shape", async () => {
    const { db } = makeMockDb({ selectResults: [[]] });
    const tool = buildToolBound("weather.get_for_snapshot", db);
    const result = await tool.handler(
      { forDate: "2026-05-14", locationLabel: "London, UK" },
      ctx(),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(
        (result.result as { data: unknown }).data,
      ).toBeNull();
    }
  });
});

// ─── Tool: weather.dismiss ──────────────────────────────────────

describe("weather.dismiss", () => {
  it.each([
    ["dismissed", "weather_dismissed"],
    ["too_detailed", "weather_too_detailed"],
    ["too_terse", "weather_too_terse"],
  ] as const)(
    "kind=%s maps to signal_kind=%s and writes a feedback row",
    async (kind, expectedSignalKind) => {
      const row = {
        id: "weather-1",
        tenantId: "00000000-0000-0000-0000-000000000001",
        locationLabel: "London, UK",
        forDate: "2026-05-14",
        conditionCode: "rain",
        summary: "Heavy rain · 11–18°C · 95% precip",
      };
      const { db, calls } = makeMockDb({ selectResults: [[row]] });
      const tool = buildToolBound("weather.dismiss", db);

      const result = await tool.handler(
        {
          id: "00000000-0000-0000-0000-000000000aaa",
          kind,
        },
        ctx({ wakeOwnerUserId: "00000000-0000-0000-0000-0000000000ff" }),
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(
          (result.result as { data: { signalKind: string } }).data.signalKind,
        ).toBe(expectedSignalKind);
      }

      // writeFeedback awaits insert().values() directly (no .returning()).
      // Our mock counts that as `insertAwaited`.
      expect(calls.insertAwaited).toBe(1);
      const v = calls.insertValues[0] as Record<string, unknown>;
      expect(v.signalKind).toBe(expectedSignalKind);
      expect(v.subjectKind).toBe("weather");
      expect(v.subjectId).toBe("00000000-0000-0000-0000-000000000aaa");
      expect(v.tenantId).toBe("00000000-0000-0000-0000-000000000001");
      expect(v.createdByUserId).toBe(
        "00000000-0000-0000-0000-0000000000ff",
      );
      const payload = v.value as Record<string, unknown>;
      expect(payload.locationLabel).toBe("London, UK");
      expect(payload.forDate).toBe("2026-05-14");
      expect(payload.conditionCode).toBe("rain");
      expect(payload.summary).toBe(row.summary);
    },
  );

  it("returns not_found when the row doesn't belong to the current tenant", async () => {
    const { db, calls } = makeMockDb({ selectResults: [[]] });
    const tool = buildToolBound("weather.dismiss", db);

    const result = await tool.handler(
      { id: "00000000-0000-0000-0000-000000000aaa", kind: "dismissed" },
      ctx(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("not_found");
    }
    // No feedback write happened.
    expect(calls.insertAwaited).toBe(0);
    expect(calls.insertValues.length).toBe(0);
  });
});

// ─── Sanity: tool surface count ─────────────────────────────────

describe("createWeatherTools (tool surface)", () => {
  it("exposes exactly three tools with the expected names", () => {
    const tools = createWeatherTools(deps({}) as Parameters<typeof createWeatherTools>[0]);
    expect(tools.map((t) => t.name).sort()).toEqual([
      "weather.dismiss",
      "weather.fetch_for_date",
      "weather.get_for_snapshot",
    ]);
  });

  it("every tool has a description and a Zod input schema", () => {
    const tools = createWeatherTools(deps({}) as Parameters<typeof createWeatherTools>[0]);
    for (const t of tools) {
      expect(typeof t.description).toBe("string");
      expect((t.description ?? "").length).toBeGreaterThan(10);
      expect(t.inputs).toBeDefined();
    }
  });
});
