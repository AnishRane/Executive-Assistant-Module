// Open-Meteo client. No API key required; generous free tier.
// Docs: https://open-meteo.com/en/docs
//
// We fetch the daily forecast for a single date at a single coordinate
// and capture more than the 6-bucket condition the first cut shipped
// with — David asked for more precision in temperature, feel, and
// conditions. The fields tracked here:
//
//   - WMO weather_code, mapped two ways:
//       * conditionCode  — 6-bucket enum (drives UI tokens + filters)
//       * conditionLabel — granular WMO label ("Partly cloudy",
//                          "Heavy rain", "Thunderstorm w/ slight hail")
//   - dry-bulb temperature_2m_max / min
//   - apparent_temperature_max / min (feels-like — wind chill + heat
//     index combined; can move 5–10°C off dry-bulb in extreme wind or
//     humidity)
//   - precipitation_sum (mm) + precipitation_probability_max
//   - wind_speed_10m_max + wind_gusts_10m_max (km/h)
//   - uv_index_max
//   - sunrise, sunset (ISO timestamps in the requested tz)
//
// raw_payload preserves the full response so future iterations can
// re-derive a richer summary without re-hitting the provider.

export type ConditionCode =
  | "clear"
  | "cloudy"
  | "rain"
  | "snow"
  | "storm"
  | "fog";

export interface OpenMeteoDaily {
  conditionCode: ConditionCode;
  conditionLabel: string;

  tempHighC: number;
  tempLowC: number;
  tempApparentHighC: number;
  tempApparentLowC: number;

  precipProbabilityMax: number | null;
  precipitationMm: number | null;

  windSpeedMaxKmh: number | null;
  windGustsMaxKmh: number | null;

  uvIndexMax: number | null;

  sunrise: string | null;
  sunset: string | null;

  raw: Record<string, unknown>;
}

// WMO weather code → 6-bucket enum used by UI tokens / filters.
// Exported so unit tests can exercise the mapping table without
// stubbing fetch.
export function mapWmoCode(code: number): ConditionCode {
  if (code === 0) return "clear";
  if (code <= 3) return "cloudy";
  if (code === 45 || code === 48) return "fog";
  if (code >= 51 && code <= 67) return "rain";
  if (code >= 71 && code <= 77) return "snow";
  if (code >= 80 && code <= 82) return "rain";
  if (code >= 85 && code <= 86) return "snow";
  if (code >= 95 && code <= 99) return "storm";
  return "cloudy";
}

// WMO weather code → precise human label.
// Source: https://open-meteo.com/en/docs#weather_variable_documentation
// Unknown codes fall back to "Unknown conditions" — defensive, never
// the empty string.
export function describeWmoCode(code: number): string {
  switch (code) {
    case 0:
      return "Clear sky";
    case 1:
      return "Mainly clear";
    case 2:
      return "Partly cloudy";
    case 3:
      return "Overcast";
    case 45:
      return "Fog";
    case 48:
      return "Freezing fog";
    case 51:
      return "Light drizzle";
    case 53:
      return "Moderate drizzle";
    case 55:
      return "Heavy drizzle";
    case 56:
      return "Light freezing drizzle";
    case 57:
      return "Heavy freezing drizzle";
    case 61:
      return "Light rain";
    case 63:
      return "Moderate rain";
    case 65:
      return "Heavy rain";
    case 66:
      return "Light freezing rain";
    case 67:
      return "Heavy freezing rain";
    case 71:
      return "Light snow";
    case 73:
      return "Moderate snow";
    case 75:
      return "Heavy snow";
    case 77:
      return "Snow grains";
    case 80:
      return "Light rain showers";
    case 81:
      return "Moderate rain showers";
    case 82:
      return "Violent rain showers";
    case 85:
      return "Light snow showers";
    case 86:
      return "Heavy snow showers";
    case 95:
      return "Thunderstorm";
    case 96:
      return "Thunderstorm with slight hail";
    case 99:
      return "Thunderstorm with heavy hail";
    default:
      return "Unknown conditions";
  }
}

export async function fetchOpenMeteoDaily(args: {
  latitude: number;
  longitude: number;
  forDate: string; // YYYY-MM-DD
  tz: string;
}): Promise<OpenMeteoDaily> {
  const url = new URL("https://api.open-meteo.com/v1/forecast");
  url.searchParams.set("latitude", String(args.latitude));
  url.searchParams.set("longitude", String(args.longitude));
  url.searchParams.set("timezone", args.tz);
  url.searchParams.set("start_date", args.forDate);
  url.searchParams.set("end_date", args.forDate);
  url.searchParams.set("wind_speed_unit", "kmh");
  url.searchParams.set("temperature_unit", "celsius");
  url.searchParams.set("precipitation_unit", "mm");
  url.searchParams.set(
    "daily",
    [
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
    ].join(","),
  );

  const res = await fetch(url.toString());
  if (!res.ok) {
    throw new Error(
      `open-meteo ${res.status} ${res.statusText} for ${args.forDate} @ ${args.latitude},${args.longitude}`,
    );
  }
  const json = (await res.json()) as {
    daily?: {
      time?: string[];
      weather_code?: number[];
      temperature_2m_max?: (number | null)[];
      temperature_2m_min?: (number | null)[];
      apparent_temperature_max?: (number | null)[];
      apparent_temperature_min?: (number | null)[];
      precipitation_sum?: (number | null)[];
      precipitation_probability_max?: (number | null)[];
      wind_speed_10m_max?: (number | null)[];
      wind_gusts_10m_max?: (number | null)[];
      uv_index_max?: (number | null)[];
      sunrise?: (string | null)[];
      sunset?: (string | null)[];
    };
  };
  const d = json.daily;
  if (!d || !d.time?.length) {
    throw new Error(`open-meteo: empty daily payload for ${args.forDate}`);
  }
  const i = d.time.indexOf(args.forDate);
  const idx = i >= 0 ? i : 0;
  const code = d.weather_code?.[idx] ?? 3;

  const nullableNum = (arr: (number | null)[] | undefined): number | null => {
    const v = arr?.[idx];
    return v === null || v === undefined ? null : v;
  };
  const numOrNaN = (arr: (number | null)[] | undefined): number => {
    const v = arr?.[idx];
    return v === null || v === undefined ? NaN : v;
  };

  return {
    conditionCode: mapWmoCode(code),
    conditionLabel: describeWmoCode(code),

    tempHighC: numOrNaN(d.temperature_2m_max),
    tempLowC: numOrNaN(d.temperature_2m_min),
    tempApparentHighC: numOrNaN(d.apparent_temperature_max),
    tempApparentLowC: numOrNaN(d.apparent_temperature_min),

    precipProbabilityMax: nullableNum(d.precipitation_probability_max),
    precipitationMm: nullableNum(d.precipitation_sum),

    windSpeedMaxKmh: nullableNum(d.wind_speed_10m_max),
    windGustsMaxKmh: nullableNum(d.wind_gusts_10m_max),

    uvIndexMax: nullableNum(d.uv_index_max),

    sunrise: d.sunrise?.[idx] ?? null,
    sunset: d.sunset?.[idx] ?? null,

    raw: json as Record<string, unknown>,
  };
}

// Compact human one-liner the agent can read or fall back to as-is.
// The agent is encouraged to re-phrase in David's voice — this is the
// safe default if the agent skips composition.
//
// Format: "<Condition> · <low>–<high>°C (feels <fl>°C if diverged)
//          [· <gusts> km/h gusts] [· UV <n>] [· <precip>mm precip]"
//
// Each suffix is included only when meaningful:
//   - feels-like only if it diverges from the dry-bulb mid by ≥3°C
//   - gusts only if ≥40 km/h
//   - UV only if ≥6 (high)
//   - precip mm only if ≥1 mm (anything less is drizzle noise)
export function defaultSummary(d: OpenMeteoDaily): string {
  const high = Number.isFinite(d.tempHighC) ? Math.round(d.tempHighC) : null;
  const low = Number.isFinite(d.tempLowC) ? Math.round(d.tempLowC) : null;
  const rangeBase =
    high !== null && low !== null
      ? `${low}–${high}°C`
      : high !== null
        ? `${high}°C`
        : low !== null
          ? `${low}°C`
          : "";

  // Feels-like add-on, only when meaningfully different.
  let feels = "";
  if (
    Number.isFinite(d.tempApparentHighC) &&
    Number.isFinite(d.tempApparentLowC) &&
    high !== null &&
    low !== null
  ) {
    const aHigh = Math.round(d.tempApparentHighC);
    const aLow = Math.round(d.tempApparentLowC);
    const midDry = (high + low) / 2;
    const midApp = (aHigh + aLow) / 2;
    if (Math.abs(midDry - midApp) >= 3) {
      feels = ` (feels ${aLow}–${aHigh}°C)`;
    }
  }

  const range = rangeBase + feels;

  const parts: string[] = [];
  if (d.conditionLabel) parts.push(d.conditionLabel);
  if (range) parts.push(range);

  // Precip — show the chance (probability) if ≥40, the volume if ≥1mm.
  const probShown =
    d.precipProbabilityMax !== null && d.precipProbabilityMax >= 40;
  const volShown = d.precipitationMm !== null && d.precipitationMm >= 1;
  if (probShown && volShown) {
    parts.push(
      `${d.precipProbabilityMax}% precip · ${d.precipitationMm!.toFixed(1)} mm`,
    );
  } else if (probShown) {
    parts.push(`${d.precipProbabilityMax}% precip`);
  } else if (volShown) {
    parts.push(`${d.precipitationMm!.toFixed(1)} mm precip`);
  }

  if (d.windGustsMaxKmh !== null && d.windGustsMaxKmh >= 40) {
    parts.push(`${Math.round(d.windGustsMaxKmh)} km/h gusts`);
  }

  if (d.uvIndexMax !== null && d.uvIndexMax >= 6) {
    parts.push(`UV ${Math.round(d.uvIndexMax)}`);
  }

  return parts.join(" · ");
}
