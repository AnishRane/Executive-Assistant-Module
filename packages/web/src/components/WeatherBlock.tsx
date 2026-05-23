// Two-line weather block above the day's narrative.
//
//   Line 1: Location · Condition label · Range (feels-like if diverged)
//   Line 2: Chips — precip, wind, UV, sunrise/sunset — each rendered
//           only when meaningful (no 0 mm precip, no 0 UV at night).
//
// Overflow menu writes a feedback signal so David can quietly tune the
// block over time without having to talk to anyone:
//   • Dismiss for today — hide locally + write weather_dismissed
//   • Too detailed — write weather_too_detailed
//   • Too terse — write weather_too_terse
//
// We don't *delete* the row on dismiss — the agent's weekly reflection
// reads the signal stream. Repeated dismissals tune david.voice /
// david.weather.preferences.

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { WeatherSnapshot } from "../hooks/useDossier.js";
import { callTool } from "../lib/api.js";
import { formatTime } from "../lib/format.js";

function tempRange(d: WeatherSnapshot): string {
  const fmt = (n: number) => `${Math.round(n)}°`;
  const high = d.tempHighC;
  const low = d.tempLowC;
  if (high === null && low === null) return "";
  if (high !== null && low !== null) return `${fmt(low)} / ${fmt(high)}C`;
  return fmt((high ?? low) as number) + "C";
}

function feelsLikeNote(d: WeatherSnapshot): string | null {
  // Show only when feels-like diverges meaningfully from dry-bulb.
  const { tempHighC, tempLowC, tempApparentHighC, tempApparentLowC } = d;
  if (
    tempHighC === null ||
    tempLowC === null ||
    tempApparentHighC === null ||
    tempApparentLowC === null
  ) {
    return null;
  }
  const midDry = (tempHighC + tempLowC) / 2;
  const midApp = (tempApparentHighC + tempApparentLowC) / 2;
  if (Math.abs(midDry - midApp) < 3) return null;
  const aHigh = Math.round(tempApparentHighC);
  const aLow = Math.round(tempApparentLowC);
  return `feels ${aLow}° / ${aHigh}°C`;
}

function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center font-mono text-[11px] tracking-[0.02em] text-[var(--color-ink-soft)] border border-[var(--color-rule)] bg-[var(--color-paper)] rounded-sm px-1.5 py-0.5">
      {children}
    </span>
  );
}

export function WeatherBlock({ data }: { data: WeatherSnapshot }) {
  const qc = useQueryClient();
  const [menuOpen, setMenuOpen] = useState(false);
  const [dismissedLocally, setDismissedLocally] = useState(false);

  if (dismissedLocally) return null;

  const range = tempRange(data);
  const feels = feelsLikeNote(data);
  const label = data.conditionLabel ?? "—";

  // Build the chip row conditionally — only show what's worth a line.
  const chips: { key: string; label: string }[] = [];

  if (data.precipProbabilityMax !== null && data.precipProbabilityMax >= 40) {
    const mm =
      data.precipitationMm !== null && data.precipitationMm >= 1
        ? ` · ${data.precipitationMm.toFixed(1)} mm`
        : "";
    chips.push({
      key: "precip",
      label: `${data.precipProbabilityMax}% precip${mm}`,
    });
  } else if (data.precipitationMm !== null && data.precipitationMm >= 1) {
    chips.push({
      key: "precip",
      label: `${data.precipitationMm.toFixed(1)} mm precip`,
    });
  }

  if (data.windGustsMaxKmh !== null && data.windGustsMaxKmh >= 40) {
    const sustained =
      data.windSpeedMaxKmh !== null && data.windSpeedMaxKmh > 0
        ? `${Math.round(data.windSpeedMaxKmh)}/`
        : "";
    chips.push({
      key: "wind",
      label: `Wind ${sustained}${Math.round(data.windGustsMaxKmh)} km/h`,
    });
  } else if (
    data.windSpeedMaxKmh !== null &&
    data.windSpeedMaxKmh >= 25
  ) {
    chips.push({
      key: "wind",
      label: `Wind ${Math.round(data.windSpeedMaxKmh)} km/h`,
    });
  }

  if (data.uvIndexMax !== null && data.uvIndexMax >= 6) {
    chips.push({
      key: "uv",
      label: `UV ${Math.round(data.uvIndexMax)}`,
    });
  }

  if (data.sunrise && data.sunset) {
    chips.push({
      key: "sun",
      label: `${formatTime(new Date(data.sunrise))}–${formatTime(new Date(data.sunset))}`,
    });
  }

  async function record(kind: "dismissed" | "too_detailed" | "too_terse") {
    setMenuOpen(false);
    try {
      await callTool<{ id: string; kind: typeof kind }, { data: unknown }>(
        "executive-assistant.weather.dismiss",
        { id: data.id, kind },
      );
      qc.invalidateQueries({ queryKey: ["ea", "feedback_signals"] });
      if (kind === "dismissed") setDismissedLocally(true);
    } catch {
      // Best-effort — silent. User can refresh if the feedback didn't stick.
    }
  }

  return (
    <div className="mb-5 border border-[var(--color-rule)] bg-[var(--color-paper-warm)] rounded-md px-4 py-3">
      <div className="flex items-baseline gap-3 flex-wrap">
        <span className="font-mono text-[10.5px] tracking-[0.16em] uppercase text-[var(--color-ink-faint)]">
          {data.locationLabel}
        </span>
        <span className="text-[var(--color-ink)] text-[15px]">{label}</span>
        {range && (
          <span className="font-mono text-[13px] text-[var(--color-ink)]">
            {range}
          </span>
        )}
        {feels && (
          <span className="font-mono text-[11.5px] text-[var(--color-ink-faint)] italic">
            {feels}
          </span>
        )}
        <div className="ml-auto relative">
          <button
            type="button"
            onClick={() => setMenuOpen((v) => !v)}
            aria-label="Weather options"
            className="text-[var(--color-ink-faint)] hover:text-[var(--color-ink)] text-[16px] leading-none px-1"
          >
            ⋯
          </button>
          {menuOpen && (
            <div className="absolute right-0 top-full mt-1 z-10 min-w-[180px] bg-[var(--color-paper)] border border-[var(--color-rule)] shadow-sm">
              <button
                type="button"
                onClick={() => record("dismissed")}
                className="block w-full text-left px-3 py-2 text-[13.5px] text-[var(--color-ink)] hover:bg-[var(--color-rule-soft)]"
              >
                Dismiss for today
              </button>
              <button
                type="button"
                onClick={() => record("too_detailed")}
                className="block w-full text-left px-3 py-2 text-[13.5px] text-[var(--color-ink)] hover:bg-[var(--color-rule-soft)] border-t border-[var(--color-rule-soft)]"
              >
                Too detailed
              </button>
              <button
                type="button"
                onClick={() => record("too_terse")}
                className="block w-full text-left px-3 py-2 text-[13.5px] text-[var(--color-ink)] hover:bg-[var(--color-rule-soft)] border-t border-[var(--color-rule-soft)]"
              >
                Too terse
              </button>
            </div>
          )}
        </div>
      </div>

      {chips.length > 0 && (
        <div className="mt-2 flex items-center gap-1.5 flex-wrap">
          {chips.map((c) => (
            <Chip key={c.key}>{c.label}</Chip>
          ))}
        </div>
      )}

      {data.summary && (
        <div className="mt-2 text-[var(--color-ink-soft)] text-[13.5px] italic">
          {data.summary}
        </div>
      )}
    </div>
  );
}
