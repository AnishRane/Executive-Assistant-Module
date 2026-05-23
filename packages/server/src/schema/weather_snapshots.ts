import {
  pgTable,
  uuid,
  text,
  timestamp,
  date,
  real,
  integer,
  jsonb,
  index,
} from "drizzle-orm/pg-core";

// One row per (tenant, date, location_label). Fetched once per morning
// during compose; UI reads via weather.get_for_snapshot.
//
// Two condition signals coexist:
//   - condition_code: a 6-bucket enum (clear / cloudy / fog / rain / snow
//     / storm) — drives UI tokens, filters, the agent's notable check.
//   - condition_label: the granular WMO description ("Partly cloudy",
//     "Heavy rain", "Thunderstorm with slight hail") — drives the
//     human-readable summary the agent and UI display.
//
// Apparent (feels-like) temperatures are tracked separately so the
// agent can lead with the right number — wind chill or heat index can
// move "feels like" 5–10°C off the dry-bulb reading.
//
// raw_payload preserves the full Open-Meteo response so a richer
// derivation later doesn't need a re-fetch.

export const weatherSnapshots = pgTable(
  "executive_assistant__weather_snapshots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    forDate: date("for_date").notNull(),
    locationLabel: text("location_label").notNull(),
    latitude: real("latitude").notNull(),
    longitude: real("longitude").notNull(),
    tz: text("tz").notNull(),

    summary: text("summary"),
    conditionCode: text("condition_code"),
    conditionLabel: text("condition_label"),

    // Dry-bulb high / low (°C)
    tempHighC: real("temp_high_c"),
    tempLowC: real("temp_low_c"),

    // Apparent (feels-like) high / low (°C)
    tempApparentHighC: real("temp_apparent_high_c"),
    tempApparentLowC: real("temp_apparent_low_c"),

    // Precipitation
    precipProbabilityMax: integer("precip_probability_max"),
    precipitationMm: real("precipitation_mm"),

    // Wind (km/h)
    windSpeedMaxKmh: real("wind_speed_max_kmh"),
    windGustsMaxKmh: real("wind_gusts_max_kmh"),

    uvIndexMax: real("uv_index_max"),

    sunrise: timestamp("sunrise", { withTimezone: true }),
    sunset: timestamp("sunset", { withTimezone: true }),

    rawPayload: jsonb("raw_payload").$type<Record<string, unknown>>().notNull().default({}),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    tenantDateIdx: index("ea__weather_tenant_date_idx").on(
      table.tenantId,
      table.forDate,
    ),
  }),
);
