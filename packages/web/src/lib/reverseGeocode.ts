// reverseGeocode — turn (latitude, longitude) into a human label.
//
// Uses OpenStreetMap Nominatim (free, no API key, fair-use limit
// 1 req/sec which we are nowhere near). We call it at most once per
// /executive page load when navigator.geolocation succeeds, then
// cache the result via the preferences table on the server.
//
// Label format: "<suburb>, <state>" with sensible fallbacks if the
// suburb-equivalent field is missing in the response. The address
// object Nominatim returns varies by country and area type; the
// most-specific-locality-or-equivalent + state pattern works across
// most populated places.
//
// Fallback strategy: when Nominatim fails (rate-limited, offline,
// 5xx, parse error, timeout), throw — the caller decides what to
// substitute (typically the broadscoped IANA timezone like
// "Asia/Calcutta" to signal "this is the timezone, not a place").

export interface NominatimAddress {
  suburb?: string;
  neighbourhood?: string;
  city_district?: string;
  village?: string;
  town?: string;
  hamlet?: string;
  city?: string;
  municipality?: string;
  county?: string;
  state_district?: string;
  state?: string;
  region?: string;
  country?: string;
}

export interface NominatimResponse {
  display_name?: string;
  address?: NominatimAddress;
}

export interface ReverseGeocodeResult {
  /** "Ambarnath, Maharashtra" style label. */
  label: string;
  /** Raw response, kept for debugging / future use. */
  raw: NominatimResponse;
}

interface FetchLike {
  (input: string, init?: RequestInit): Promise<{
    ok: boolean;
    status: number;
    json: () => Promise<unknown>;
  }>;
}

const NOMINATIM_BASE = "https://nominatim.openstreetmap.org/reverse";

/**
 * Build the final label from a Nominatim address record.
 *
 * Locality priority (most specific first): suburb, neighbourhood,
 * city_district, village, town, hamlet, city, municipality, county.
 *
 * Region priority: state, state_district, region, country.
 *
 * If both are absent, returns null so the caller knows to fall back.
 */
export function labelFromAddress(addr: NominatimAddress | undefined): string | null {
  if (!addr) return null;
  const locality =
    addr.suburb ??
    addr.neighbourhood ??
    addr.city_district ??
    addr.village ??
    addr.town ??
    addr.hamlet ??
    addr.city ??
    addr.municipality ??
    addr.county ??
    null;
  const region =
    addr.state ?? addr.state_district ?? addr.region ?? addr.country ?? null;

  if (locality && region && locality !== region) {
    return `${locality}, ${region}`;
  }
  if (locality) return locality;
  if (region) return region;
  return null;
}

export async function reverseGeocode(
  latitude: number,
  longitude: number,
  opts: {
    timeoutMs?: number;
    fetchImpl?: FetchLike;
    signal?: AbortSignal;
  } = {},
): Promise<ReverseGeocodeResult> {
  const { timeoutMs = 5000, fetchImpl = fetch as unknown as FetchLike } = opts;

  const url =
    `${NOMINATIM_BASE}?lat=${encodeURIComponent(latitude.toFixed(5))}` +
    `&lon=${encodeURIComponent(longitude.toFixed(5))}` +
    `&format=json&zoom=12&addressdetails=1`;

  // Compose abort: combine caller signal + timeout. We don't import
  // AbortController explicitly so this stays usable in any browser
  // env that exposes it natively (all modern ones do).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ctrl = new (globalThis as any).AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  if (opts.signal) opts.signal.addEventListener("abort", () => ctrl.abort());

  try {
    const res = await fetchImpl(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
      },
      signal: ctrl.signal,
    });

    if (!res.ok) {
      throw new Error(`nominatim_${res.status}`);
    }
    const body = (await res.json()) as NominatimResponse;
    const label = labelFromAddress(body.address);
    if (!label) {
      throw new Error("nominatim_label_missing");
    }
    return { label, raw: body };
  } finally {
    clearTimeout(timer);
  }
}
