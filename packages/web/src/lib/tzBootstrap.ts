// Browser-side timezone bootstrap. Runs once per /executive load
// (per session). Detects the browser's IANA timezone, compares against
// what the server has stored, and writes the executive-assistant
// preferences table via executive-assistant.preferences.{get,set}.
//
// v0.4.14: was previously using framework.memory.* tools — that was
// wrong; memory is semantic-search, not key/value. The new preferences
// table is the correct home for structured tenant settings.

export type TzCallTool = <I, R>(name: string, input: I) => Promise<R>;
export type GetBrowserTz = () => string | null;

export interface BootstrapResult {
  /** What we wrote to memory, if anything. */
  wrote: "nothing" | "current" | "current+home";
  /** The detected browser tz, or null if undetectable. */
  tz: string | null;
}

interface PrefGetResult {
  data?: { value?: { tz?: string; label?: string } | null };
}

function defaultGetBrowserTz(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

function labelFromIana(iana: string): string {
  // v0.1.8 — keep the FULL IANA tz as the bootstrap-time label
  // (e.g. "Asia/Calcutta") so the UI is honest about what's known
  // until the geolocation effect upgrades it to a real place name
  // ("Ambarnath, Maharashtra") via reverse geocoding. The old
  // `split("/").pop()` derivation gave "Calcutta" which looked like
  // a city but was just a stripped tz segment with no geographic
  // truth behind it. Showing "Asia/Calcutta" honestly signals
  // "we only know the timezone right now".
  return iana;
}

export async function bootstrapTimezone(
  callTool: TzCallTool,
  getBrowserTz: GetBrowserTz = defaultGetBrowserTz,
): Promise<BootstrapResult> {
  const browserTz = getBrowserTz();
  if (!browserTz) return { wrote: "nothing", tz: null };
  const label = labelFromIana(browserTz);

  // Read current_location preference
  let currentTz: string | null = null;
  try {
    const r = await callTool<{ key: string }, PrefGetResult>(
      "executive-assistant.preferences.get",
      { key: "current_location" },
    );
    currentTz = r?.data?.value?.tz ?? null;
  } catch {
    // server unreachable — abort silently
    return { wrote: "nothing", tz: browserTz };
  }

  let wroteCurrent = false;
  if (currentTz !== browserTz) {
    try {
      await callTool("executive-assistant.preferences.set", {
        key: "current_location",
        value: { label, tz: browserTz },
      });
      wroteCurrent = true;
    } catch {
      return { wrote: "nothing", tz: browserTz };
    }
  }

  // First-time setup: if home_location is empty, mirror current there.
  let wroteHome = false;
  try {
    const r = await callTool<{ key: string }, PrefGetResult>(
      "executive-assistant.preferences.get",
      { key: "home_location" },
    );
    const homeTz = r?.data?.value?.tz ?? null;
    if (!homeTz) {
      await callTool("executive-assistant.preferences.set", {
        key: "home_location",
        value: { label, tz: browserTz },
      });
      wroteHome = true;
    }
  } catch {
    // ignore — home is optional, current is what mattered
  }

  const wrote: BootstrapResult["wrote"] =
    wroteCurrent && wroteHome
      ? "current+home"
      : wroteHome
        ? "current+home"
        : wroteCurrent
          ? "current"
          : "nothing";

  return { wrote, tz: browserTz };
}
