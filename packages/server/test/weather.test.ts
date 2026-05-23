// Weather service tests.
//
// Two layers:
//
//   1. UNIT — pure functions (mapWmoCode, describeWmoCode,
//      defaultSummary) and fetchOpenMeteoDaily with the global fetch
//      stubbed. Always runs, no network, fast.
//
//   2. INTEGRATION — fetchOpenMeteoDaily hitting the real Open-Meteo
//      endpoint. Gated on EA_INTEGRATION_TEST=1 so offline runs and
//      CI without network egress stay green. Run with:
//
//        EA_INTEGRATION_TEST=1 pnpm test
//
//      The integration test is a soft contract check — it verifies
//      shape + plausibility for every expanded field, not exact values
//      (weather changes).

import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
} from "vitest";
import {
  mapWmoCode,
  describeWmoCode,
  defaultSummary,
  fetchOpenMeteoDaily,
  type OpenMeteoDaily,
} from "../src/services/weather.js";

// ─── Unit: WMO code → 6-bucket enum (mapWmoCode) ───────────────

describe("mapWmoCode", () => {
  it.each([
    [0, "clear"],
    [1, "cloudy"],
    [2, "cloudy"],
    [3, "cloudy"],
    [45, "fog"],
    [48, "fog"],
    [51, "rain"],
    [55, "rain"],
    [61, "rain"],
    [65, "rain"],
    [67, "rain"],
    [71, "snow"],
    [75, "snow"],
    [77, "snow"],
    [80, "rain"],
    [82, "rain"],
    [85, "snow"],
    [86, "snow"],
    [95, "storm"],
    [99, "storm"],
  ])("code %i → %s", (code, expected) => {
    expect(mapWmoCode(code)).toBe(expected);
  });

  it("falls back to cloudy for unknown codes", () => {
    expect(mapWmoCode(9999)).toBe("cloudy");
    expect(mapWmoCode(78)).toBe("cloudy");
    expect(mapWmoCode(79)).toBe("cloudy");
  });
});

// ─── Unit: WMO code → granular label (describeWmoCode) ─────────

describe("describeWmoCode", () => {
  it.each([
    [0, "Clear sky"],
    [1, "Mainly clear"],
    [2, "Partly cloudy"],
    [3, "Overcast"],
    [45, "Fog"],
    [48, "Freezing fog"],
    [51, "Light drizzle"],
    [53, "Moderate drizzle"],
    [55, "Heavy drizzle"],
    [56, "Light freezing drizzle"],
    [57, "Heavy freezing drizzle"],
    [61, "Light rain"],
    [63, "Moderate rain"],
    [65, "Heavy rain"],
    [66, "Light freezing rain"],
    [67, "Heavy freezing rain"],
    [71, "Light snow"],
    [73, "Moderate snow"],
    [75, "Heavy snow"],
    [77, "Snow grains"],
    [80, "Light rain showers"],
    [81, "Moderate rain showers"],
    [82, "Violent rain showers"],
    [85, "Light snow showers"],
    [86, "Heavy snow showers"],
    [95, "Thunderstorm"],
    [96, "Thunderstorm with slight hail"],
    [99, "Thunderstorm with heavy hail"],
  ])("code %i → %s", (code, expected) => {
    expect(describeWmoCode(code)).toBe(expected);
  });

  it("returns a stable fallback string for unknown codes", () => {
    expect(describeWmoCode(9999)).toBe("Unknown conditions");
    expect(describeWmoCode(78)).toBe("Unknown conditions");
  });

  it("returns a non-empty string for every code in the documented WMO range", () => {
    // Smoke test the surface — every code we map must produce non-empty
    // output (the granular label is what UI shows; "" would render as
    // a leading-space artifact).
    for (let code = 0; code <= 99; code++) {
      const label = describeWmoCode(code);
      expect(label.length).toBeGreaterThan(0);
    }
  });
});

// ─── Unit: defaultSummary ──────────────────────────────────────

describe("defaultSummary", () => {
  function daily(overrides: Partial<OpenMeteoDaily> = {}): OpenMeteoDaily {
    return {
      conditionCode: "clear",
      conditionLabel: "Clear sky",
      tempHighC: 24,
      tempLowC: 14,
      tempApparentHighC: 24,
      tempApparentLowC: 14,
      precipProbabilityMax: 0,
      precipitationMm: 0,
      windSpeedMaxKmh: 8,
      windGustsMaxKmh: 14,
      uvIndexMax: 3,
      sunrise: "2026-05-14T05:30:00+00:00",
      sunset: "2026-05-14T20:30:00+00:00",
      raw: {},
      ...overrides,
    };
  }

  it("formats a clear day with the granular label and temp range", () => {
    expect(defaultSummary(daily())).toBe("Clear sky · 14–24°C");
  });

  it("uses the granular label, not the 6-bucket condition code", () => {
    expect(
      defaultSummary(
        daily({ conditionCode: "rain", conditionLabel: "Heavy rain" }),
      ),
    ).toContain("Heavy rain");
  });

  it("appends a feels-like clause when apparent temp diverges ≥3°C", () => {
    // Mid dry-bulb = 0°C; mid apparent = -8°C → 8°C divergence
    const out = defaultSummary(
      daily({
        conditionCode: "snow",
        conditionLabel: "Heavy snow",
        tempHighC: 2,
        tempLowC: -2,
        tempApparentHighC: -4,
        tempApparentLowC: -12,
      }),
    );
    expect(out).toContain("(feels -12–-4°C)");
  });

  it("does not append feels-like when divergence is small", () => {
    // Mid dry = 19, mid apparent = 20 → 1°C divergence; suppressed.
    const out = defaultSummary(
      daily({
        tempHighC: 22,
        tempLowC: 16,
        tempApparentHighC: 23,
        tempApparentLowC: 17,
      }),
    );
    expect(out).not.toContain("feels");
  });

  it("shows precip probability + volume when both are above threshold", () => {
    const out = defaultSummary(
      daily({
        conditionCode: "rain",
        conditionLabel: "Heavy rain",
        precipProbabilityMax: 90,
        precipitationMm: 12.4,
      }),
    );
    expect(out).toContain("90% precip · 12.4 mm");
  });

  it("shows volume alone when probability is below threshold but volume is present", () => {
    const out = defaultSummary(
      daily({
        conditionLabel: "Light rain",
        precipProbabilityMax: 10,
        precipitationMm: 2.5,
      }),
    );
    expect(out).toContain("2.5 mm precip");
    expect(out).not.toContain("% precip");
  });

  it("shows probability alone when ≥40% but volume is below 1mm", () => {
    const out = defaultSummary(
      daily({
        precipProbabilityMax: 60,
        precipitationMm: 0.3,
      }),
    );
    expect(out).toContain("60% precip");
    expect(out).not.toContain("mm");
  });

  it("omits precip clause entirely when both metrics are below threshold", () => {
    const out = defaultSummary(
      daily({ precipProbabilityMax: 10, precipitationMm: 0 }),
    );
    expect(out).not.toMatch(/precip/);
  });

  it("appends a wind-gust note when gusts ≥40 km/h", () => {
    const out = defaultSummary(daily({ windGustsMaxKmh: 62 }));
    expect(out).toContain("62 km/h gusts");
  });

  it("omits the wind note when gusts are calm", () => {
    expect(defaultSummary(daily({ windGustsMaxKmh: 12 }))).not.toContain("gusts");
  });

  it("appends UV note when index is high (≥6)", () => {
    expect(defaultSummary(daily({ uvIndexMax: 8 }))).toContain("UV 8");
  });

  it("omits UV note when index is moderate", () => {
    expect(defaultSummary(daily({ uvIndexMax: 4 }))).not.toContain("UV");
  });

  it("rounds half-degree temps to nearest integer", () => {
    expect(
      defaultSummary(daily({ tempHighC: 24.6, tempLowC: 13.4 })),
    ).toContain("13–25°C");
  });

  it("omits the range when temps are NaN", () => {
    const out = defaultSummary(
      daily({
        tempHighC: NaN,
        tempLowC: NaN,
        tempApparentHighC: NaN,
        tempApparentLowC: NaN,
      }),
    );
    // Just the condition label, no degree-sign anywhere.
    expect(out).toBe("Clear sky");
  });

  it("treats null precip metrics as 'no precip clause'", () => {
    const out = defaultSummary(
      daily({
        conditionCode: "fog",
        conditionLabel: "Fog",
        precipProbabilityMax: null,
        precipitationMm: null,
      }),
    );
    expect(out).not.toContain("precip");
  });

  it("falls back to range-only when conditionLabel is empty", () => {
    expect(defaultSummary(daily({ conditionLabel: "" }))).toBe("14–24°C");
  });
});

// ─── Unit: fetchOpenMeteoDaily with stubbed fetch ──────────────

interface StubbedResponse {
  ok: boolean;
  status?: number;
  statusText?: string;
  body?: unknown;
}

function stubFetch(resp: StubbedResponse | (() => StubbedResponse)) {
  const fn = vi.fn(async (_url: string | URL) => {
    const r = typeof resp === "function" ? resp() : resp;
    return {
      ok: r.ok,
      status: r.status ?? (r.ok ? 200 : 500),
      statusText: r.statusText ?? (r.ok ? "OK" : "Internal Server Error"),
      json: async () => r.body,
    } as unknown as Response;
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

// Synthesise a complete daily payload at index 0 for the given date.
function fullDailyBody(forDate: string) {
  return {
    daily: {
      time: [forDate],
      weather_code: [2],
      temperature_2m_max: [22],
      temperature_2m_min: [13],
      apparent_temperature_max: [24],
      apparent_temperature_min: [12],
      precipitation_sum: [0.4],
      precipitation_probability_max: [15],
      wind_speed_10m_max: [11],
      wind_gusts_10m_max: [22],
      uv_index_max: [5],
      sunrise: [`${forDate}T05:42`],
      sunset: [`${forDate}T20:11`],
    },
  };
}

describe("fetchOpenMeteoDaily (mocked fetch)", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("requests every daily field the new model captures", async () => {
    const fetchSpy = stubFetch({ ok: true, body: fullDailyBody("2026-05-14") });

    await fetchOpenMeteoDaily({
      latitude: 37.7749,
      longitude: -122.4194,
      forDate: "2026-05-14",
      tz: "America/Los_Angeles",
    });

    const calledUrl = String(fetchSpy.mock.calls[0]![0]);
    expect(calledUrl).toContain("https://api.open-meteo.com/v1/forecast");
    expect(calledUrl).toContain("latitude=37.7749");
    expect(calledUrl).toContain("longitude=-122.4194");
    expect(calledUrl).toContain("start_date=2026-05-14");
    expect(calledUrl).toContain("end_date=2026-05-14");
    expect(calledUrl).toMatch(/timezone=America(%2F|\/)Los_Angeles/);
    expect(calledUrl).toContain("wind_speed_unit=kmh");
    expect(calledUrl).toContain("temperature_unit=celsius");
    expect(calledUrl).toContain("precipitation_unit=mm");
    // All daily params are joined into one comma-separated value, so
    // assert on substrings rather than param keys.
    for (const field of [
      "weather_code",
      "temperature_2m_max",
      "temperature_2m_min",
      "apparent_temperature_max",
      "apparent_temperature_min",
      "precipitation_sum",
      "precipitation_probability_max",
      "wind_speed_10m_max",
      "wind_gusts_10m_max",
      "uv_index_max",
      "sunrise",
      "sunset",
    ]) {
      expect(calledUrl).toContain(field);
    }
  });

  it("maps every field from the daily payload onto OpenMeteoDaily", async () => {
    stubFetch({ ok: true, body: fullDailyBody("2026-05-14") });

    const out = await fetchOpenMeteoDaily({
      latitude: 51.5,
      longitude: -0.12,
      forDate: "2026-05-14",
      tz: "Europe/London",
    });

    expect(out.conditionCode).toBe("cloudy"); // weather_code 2 → cloudy bucket
    expect(out.conditionLabel).toBe("Partly cloudy");
    expect(out.tempHighC).toBe(22);
    expect(out.tempLowC).toBe(13);
    expect(out.tempApparentHighC).toBe(24);
    expect(out.tempApparentLowC).toBe(12);
    expect(out.precipProbabilityMax).toBe(15);
    expect(out.precipitationMm).toBe(0.4);
    expect(out.windSpeedMaxKmh).toBe(11);
    expect(out.windGustsMaxKmh).toBe(22);
    expect(out.uvIndexMax).toBe(5);
    expect(out.sunrise).toBe("2026-05-14T05:42");
    expect(out.sunset).toBe("2026-05-14T20:11");
    expect(out.raw).toBeTypeOf("object");
  });

  it("picks the matching index when forDate appears at a non-zero position", async () => {
    stubFetch({
      ok: true,
      body: {
        daily: {
          time: ["2026-05-13", "2026-05-14"],
          weather_code: [3, 65], // heavy rain on day 2
          temperature_2m_max: [20, 18],
          temperature_2m_min: [12, 11],
          apparent_temperature_max: [21, 14],
          apparent_temperature_min: [11, 8],
          precipitation_sum: [0, 18.2],
          precipitation_probability_max: [10, 90],
          wind_speed_10m_max: [10, 28],
          wind_gusts_10m_max: [22, 55],
          uv_index_max: [4, 2],
          sunrise: ["2026-05-13T05:43", "2026-05-14T05:42"],
          sunset: ["2026-05-13T20:10", "2026-05-14T20:11"],
        },
      },
    });

    const out = await fetchOpenMeteoDaily({
      latitude: 51.5,
      longitude: -0.12,
      forDate: "2026-05-14",
      tz: "Europe/London",
    });

    expect(out.conditionLabel).toBe("Heavy rain");
    expect(out.tempHighC).toBe(18);
    expect(out.precipitationMm).toBe(18.2);
    expect(out.windGustsMaxKmh).toBe(55);
    expect(out.sunrise).toBe("2026-05-14T05:42");
  });

  it("falls back to index 0 when forDate isn't found in the response", async () => {
    stubFetch({
      ok: true,
      body: {
        daily: {
          time: ["2026-05-13"], // mismatch with forDate below
          weather_code: [0],
          temperature_2m_max: [22],
          temperature_2m_min: [13],
          apparent_temperature_max: [22],
          apparent_temperature_min: [13],
          precipitation_sum: [0],
          precipitation_probability_max: [5],
          wind_speed_10m_max: [10],
          wind_gusts_10m_max: [18],
          uv_index_max: [3],
          sunrise: ["2026-05-13T05:43"],
          sunset: ["2026-05-13T20:10"],
        },
      },
    });

    const out = await fetchOpenMeteoDaily({
      latitude: 0,
      longitude: 0,
      forDate: "2026-05-14",
      tz: "UTC",
    });
    expect(out.conditionLabel).toBe("Clear sky");
    expect(out.tempHighC).toBe(22);
  });

  it("throws a labelled error on non-2xx responses", async () => {
    stubFetch({ ok: false, status: 503, statusText: "Service Unavailable" });
    await expect(
      fetchOpenMeteoDaily({
        latitude: 0,
        longitude: 0,
        forDate: "2026-05-14",
        tz: "UTC",
      }),
    ).rejects.toThrow(/open-meteo 503 Service Unavailable/);
  });

  it("throws when the daily payload is empty / missing", async () => {
    stubFetch({ ok: true, body: { daily: { time: [] } } });
    await expect(
      fetchOpenMeteoDaily({
        latitude: 0,
        longitude: 0,
        forDate: "2026-05-14",
        tz: "UTC",
      }),
    ).rejects.toThrow(/empty daily payload/);
  });

  it("degrades gracefully when optional fields are absent", async () => {
    stubFetch({
      ok: true,
      body: {
        daily: {
          time: ["2026-05-14"],
          weather_code: [45],
          // Everything else intentionally absent.
        },
      },
    });
    const out = await fetchOpenMeteoDaily({
      latitude: 0,
      longitude: 0,
      forDate: "2026-05-14",
      tz: "UTC",
    });
    expect(out.conditionCode).toBe("fog");
    expect(out.conditionLabel).toBe("Fog");
    expect(Number.isNaN(out.tempHighC)).toBe(true);
    expect(Number.isNaN(out.tempLowC)).toBe(true);
    expect(Number.isNaN(out.tempApparentHighC)).toBe(true);
    expect(Number.isNaN(out.tempApparentLowC)).toBe(true);
    expect(out.precipProbabilityMax).toBeNull();
    expect(out.precipitationMm).toBeNull();
    expect(out.windSpeedMaxKmh).toBeNull();
    expect(out.windGustsMaxKmh).toBeNull();
    expect(out.uvIndexMax).toBeNull();
    expect(out.sunrise).toBeNull();
    expect(out.sunset).toBeNull();
    // defaultSummary should degrade gracefully on this shape.
    expect(defaultSummary(out)).toBe("Fog");
  });

  it("preserves explicit null values from the provider (vs treating them as missing)", async () => {
    // Open-Meteo sometimes returns null for a single day's field (e.g.
    // a city outside coverage for one metric). Make sure we surface
    // null, not undefined or NaN-as-number.
    stubFetch({
      ok: true,
      body: {
        daily: {
          time: ["2026-05-14"],
          weather_code: [0],
          temperature_2m_max: [22],
          temperature_2m_min: [13],
          apparent_temperature_max: [22],
          apparent_temperature_min: [13],
          precipitation_sum: [null],
          precipitation_probability_max: [null],
          wind_speed_10m_max: [11],
          wind_gusts_10m_max: [null],
          uv_index_max: [null],
          sunrise: [null],
          sunset: [null],
        },
      },
    });
    const out = await fetchOpenMeteoDaily({
      latitude: 0,
      longitude: 0,
      forDate: "2026-05-14",
      tz: "UTC",
    });
    expect(out.precipitationMm).toBeNull();
    expect(out.precipProbabilityMax).toBeNull();
    expect(out.windGustsMaxKmh).toBeNull();
    expect(out.uvIndexMax).toBeNull();
    expect(out.sunrise).toBeNull();
    expect(out.sunset).toBeNull();
    expect(out.windSpeedMaxKmh).toBe(11); // not null
  });
});

// ─── Integration: real Open-Meteo round-trip ────────────────────
//
// Gated behind EA_INTEGRATION_TEST=1 so default `pnpm test` runs
// stay hermetic. When enabled, this test exercises the same code
// path against the real provider — it's the contract check that
// catches schema drift on Open-Meteo's side.

const RUN_INTEGRATION = process.env.EA_INTEGRATION_TEST === "1";

describe.skipIf(!RUN_INTEGRATION)(
  "fetchOpenMeteoDaily — INTEGRATION (real network)",
  () => {
    // Pick "tomorrow" so the forecast is guaranteed available — the
    // free daily endpoint covers ~16 days forward.
    const tomorrow = (() => {
      const d = new Date();
      d.setUTCDate(d.getUTCDate() + 1);
      return d.toISOString().slice(0, 10);
    })();

    it(
      "round-trips a real request to api.open-meteo.com",
      { timeout: 15_000 },
      async () => {
        const out = await fetchOpenMeteoDaily({
          // London — a stable coordinate Open-Meteo reliably has data for.
          latitude: 51.5074,
          longitude: -0.1278,
          forDate: tomorrow,
          tz: "Europe/London",
        });

        // Shape contract — every expanded field present.
        expect(out).toHaveProperty("conditionCode");
        expect(out).toHaveProperty("conditionLabel");
        expect(out).toHaveProperty("tempHighC");
        expect(out).toHaveProperty("tempLowC");
        expect(out).toHaveProperty("tempApparentHighC");
        expect(out).toHaveProperty("tempApparentLowC");
        expect(out).toHaveProperty("precipProbabilityMax");
        expect(out).toHaveProperty("precipitationMm");
        expect(out).toHaveProperty("windSpeedMaxKmh");
        expect(out).toHaveProperty("windGustsMaxKmh");
        expect(out).toHaveProperty("uvIndexMax");
        expect(out).toHaveProperty("sunrise");
        expect(out).toHaveProperty("sunset");
        expect(out).toHaveProperty("raw");

        // Type contract.
        expect([
          "clear",
          "cloudy",
          "rain",
          "snow",
          "storm",
          "fog",
        ]).toContain(out.conditionCode);
        expect(typeof out.conditionLabel).toBe("string");
        expect(out.conditionLabel.length).toBeGreaterThan(0);

        // Plausibility — London is rarely outside −20°C..45°C.
        for (const t of [
          out.tempHighC,
          out.tempLowC,
          out.tempApparentHighC,
          out.tempApparentLowC,
        ]) {
          expect(t).toBeGreaterThan(-30);
          expect(t).toBeLessThan(50);
        }
        expect(out.tempHighC).toBeGreaterThanOrEqual(out.tempLowC);
        expect(out.tempApparentHighC).toBeGreaterThanOrEqual(
          out.tempApparentLowC,
        );

        if (out.precipProbabilityMax !== null) {
          expect(out.precipProbabilityMax).toBeGreaterThanOrEqual(0);
          expect(out.precipProbabilityMax).toBeLessThanOrEqual(100);
        }
        if (out.precipitationMm !== null) {
          expect(out.precipitationMm).toBeGreaterThanOrEqual(0);
          expect(out.precipitationMm).toBeLessThan(500); // would be record-setting
        }
        if (out.windSpeedMaxKmh !== null) {
          expect(out.windSpeedMaxKmh).toBeGreaterThanOrEqual(0);
          expect(out.windSpeedMaxKmh).toBeLessThan(300);
        }
        if (out.windGustsMaxKmh !== null) {
          expect(out.windGustsMaxKmh).toBeGreaterThanOrEqual(0);
          expect(out.windGustsMaxKmh).toBeLessThan(400);
          // Gusts should be ≥ sustained, when both are present.
          if (out.windSpeedMaxKmh !== null) {
            expect(out.windGustsMaxKmh).toBeGreaterThanOrEqual(
              out.windSpeedMaxKmh,
            );
          }
        }
        if (out.uvIndexMax !== null) {
          expect(out.uvIndexMax).toBeGreaterThanOrEqual(0);
          expect(out.uvIndexMax).toBeLessThan(15);
        }
        if (out.sunrise) {
          // Sunrise/sunset land on the same calendar day in the
          // requested timezone (London, the equator-ish latitude
          // means polar-day weirdness doesn't apply).
          expect(out.sunrise.startsWith(tomorrow)).toBe(true);
        }
        if (out.sunset) {
          expect(out.sunset.startsWith(tomorrow)).toBe(true);
        }

        // The summary helper should produce a non-empty string on real data.
        expect(defaultSummary(out).length).toBeGreaterThan(0);
      },
    );
  },
);
