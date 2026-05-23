// /executive/settings — informational settings page.
//
// Most controls live in BoringOS's admin UI (routines, memory,
// connectors). This page surfaces what EA expects, so it's easy to
// spot when something's been paused or disconnected from outside the
// module — and provides links to the right admin surface.
//
// Direct mutation (pause / resume / forget) lands in v0.2 once we
// expose the wrapper tools or proxy through the admin API.

import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useLocationPrefs, useDisplayName } from "../hooks/useDossier.js";
import { callTool } from "../lib/api.js";

const ROUTINES = [
  {
    title: "EA Sync Calendar",
    cadence: "Every 15 min",
    notes: "Pulls upcoming events from Google Calendar. Paused until Google connects.",
  },
  {
    title: "EA Scan Meeting Threads",
    cadence: "Every 15 min",
    notes: "Anchors Gmail messages that match a known meeting thread. Paused until Google connects.",
  },
  {
    title: "EA Compose",
    cadence: "Every 15 min · always-fresh",
    notes: "Hash-guarded: only wakes the executive-assistant agent when the day's state has shifted. 06:00 is just one of the 96 daily ticks.",
  },
  {
    title: "EA Weekly Reflection",
    cadence: "06:30 Mon",
    notes: "Reads 7 days of feedback signals and updates contextual memory.",
  },
  {
    title: "EA Travel Agent on triage",
    cadence: "Event-driven",
    notes: "Wakes the ea-travel-agent on every triage.classified event.",
  },
];

const MEMORY_TAGS = [
  { tag: "david.voice", purpose: "Tone, sentence length, phrasing patterns. Tuned by edited_brief signals." },
  { tag: "david.travel.preferences", purpose: "Airport buffer, seat preference, departure-time avoidances." },
  { tag: "david.lodging.preferences", purpose: "Hotels he gravitates to in his recurring cities." },
  { tag: "david.cadence", purpose: "When he reads the dossier; which cards he opens first." },
  { tag: "people.<email>", purpose: "Agent's read on a recurring external attendee." },
  { tag: "company.<domain>", purpose: "The arc of a relationship with a company." },
];

const DEPENDENCIES = [
  {
    name: "Google Calendar + Gmail",
    via: "@boringos/connector-google",
    notes: "Required for calendar sync and inbox-item creation. Triage classifies inbox items; the ea-travel-agent layers travel extraction on top.",
  },
  {
    name: "MemoryProvider (Hebbs or alternative)",
    via: "framework",
    notes: "Required for contextual memory writes during reflection. EA degrades gracefully if memory is unavailable — the morning dossier still composes from structured data alone.",
  },
];

export function Settings() {
  return (
    <div className="h-full overflow-y-auto">
      <div className="px-8 pt-8 pb-4 border-b border-[var(--color-rule-soft)]">
        <h1 className="m-0 text-2xl font-semibold leading-tight tracking-[-0.005em] text-[var(--color-ink)] mb-1">
          Executive Assistant
        </h1>
        <div className="text-[13.5px] text-[var(--color-muted)]">
          Read-only snapshot of how this module is wired
        </div>
      </div>

      <div className="px-8 py-6 max-w-[1100px]">
        <p className="text-[var(--color-ink-soft)] text-[14.5px] max-w-[680px] leading-[1.55] mb-8">
          Pause/resume, memory management, and connector wiring all live in
          the BoringOS admin UI. v0.5+ will surface direct controls here.
        </p>

        <YouSection />

        <LocationSection />

        <Section title="Routines">
          {ROUTINES.map((r) => (
            <SettingsRow key={r.title} label={r.title} secondary={r.cadence}>
              {r.notes}
            </SettingsRow>
          ))}
        </Section>

        <Section title="Memory tags">
          {MEMORY_TAGS.map((m) => (
            <SettingsRow key={m.tag} label={m.tag} mono>
              {m.purpose}
            </SettingsRow>
          ))}
        </Section>

        <Section title="Dependencies">
          {DEPENDENCIES.map((d) => (
            <SettingsRow key={d.name} label={d.name} secondary={d.via}>
              {d.notes}
            </SettingsRow>
          ))}
        </Section>

        <Section title="Module">
          <SettingsRow label="executive-assistant" secondary="v0.4.2">
            A BoringOS module that composes a daily dossier from calendar and
            email signal.
          </SettingsRow>
        </Section>
      </div>
    </div>
  );
}

function YouSection() {
  const { data: displayName, isLoading } = useDisplayName();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setDraft(displayName ?? "");
  }, [displayName]);

  async function save() {
    const value = draft.trim();
    if (value === (displayName ?? "")) return;
    setSaving(true);
    try {
      if (value === "") {
        // Clear by writing an empty-name object. The hook reads .name,
        // so an empty string reads back as null.
        await callTool<
          { key: string; value: Record<string, unknown> },
          { data: unknown }
        >("executive-assistant.preferences.set", {
          key: "display_name",
          value: { name: "" },
        });
      } else {
        await callTool<
          { key: string; value: Record<string, unknown> },
          { data: unknown }
        >("executive-assistant.preferences.set", {
          key: "display_name",
          value: { name: value },
        });
      }
      await queryClient.invalidateQueries({
        queryKey: ["ea", "preferences", "display_name"],
      });
    } catch {
      setDraft(displayName ?? "");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Section title="You">
      {isLoading ? (
        <div className="text-[13.5px] text-[var(--color-muted)] italic py-2">
          Loading…
        </div>
      ) : (
        <SettingsRow label="Name" secondary={saving ? "Saving…" : undefined}>
          <input
            type="text"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={save}
            placeholder="First name the agent should use in your brief"
            maxLength={40}
            className="w-full max-w-[280px] text-[14px] text-[var(--color-ink)] bg-[var(--color-paper)] border border-[var(--color-rule)] rounded-md px-2.5 py-1 font-sans focus:outline-none focus:border-[var(--color-accent)] focus:ring-2 focus:ring-[var(--color-accent-tint)]"
          />
          <div className="text-[12px] text-[var(--color-muted)] mt-1">
            Used occasionally in the agent's prose. Leave empty to stay anonymous.
          </div>
        </SettingsRow>
      )}
    </Section>
  );
}

function LocationSection() {
  const { data, isLoading } = useLocationPrefs();
  const queryClient = useQueryClient();
  const [saving, setSaving] = useState(false);

  const current = data?.current ?? null;
  const home = data?.home ?? null;
  const traveling = !!current && !!home && current.tz !== home.tz;
  const canSetCurrentAsHome = !!current && (!home || traveling);

  async function setCurrentAsHome() {
    if (!current) return;
    setSaving(true);
    try {
      await callTool<
        { key: string; value: Record<string, unknown> },
        { data: unknown }
      >("executive-assistant.preferences.set", {
        key: "home_location",
        value: { ...current },
      });
      await queryClient.invalidateQueries({
        queryKey: ["ea", "preferences", "locations"],
      });
    } catch {
      // best-effort; user can retry
    } finally {
      setSaving(false);
    }
  }

  return (
    <Section title="Location">
      {isLoading ? (
        <div className="text-[13.5px] text-[var(--color-muted)] italic py-2">
          Loading…
        </div>
      ) : (
        <>
          <SettingsRow
            label="Currently"
            secondary={current ? tzAbbrLocal(current.tz) : "—"}
            mono={false}
          >
            {current ? (
              <>
                {current.label} ·{" "}
                <span className="font-mono text-[12px]">{current.tz}</span>
                <div className="text-[12px] text-[var(--color-muted)] mt-0.5">
                  Auto-updated from your browser whenever you open /executive.
                </div>
              </>
            ) : (
              <span className="italic text-[var(--color-muted)]">
                Not set — open /executive once to let your browser detect it.
              </span>
            )}
          </SettingsRow>

          <SettingsRow
            label="Home"
            secondary={home ? tzAbbrLocal(home.tz) : "—"}
            mono={false}
          >
            {home ? (
              <>
                {home.label} ·{" "}
                <span className="font-mono text-[12px]">{home.tz}</span>
                <div className="text-[12px] text-[var(--color-muted)] mt-0.5">
                  Used as the anchor — falls back here when current isn't set.
                </div>
              </>
            ) : (
              <span className="italic text-[var(--color-muted)]">Not set</span>
            )}
          </SettingsRow>

          {canSetCurrentAsHome && (
            <div className="pt-2">
              <button
                type="button"
                onClick={setCurrentAsHome}
                disabled={saving}
                className="text-[12.5px] font-medium text-[var(--color-accent)] hover:underline cursor-pointer disabled:opacity-50"
              >
                {saving
                  ? "Saving…"
                  : home
                    ? `Use ${current!.label} as home instead →`
                    : `Use ${current!.label} as home →`}
              </button>
            </div>
          )}
        </>
      )}
    </Section>
  );
}

function tzAbbrLocal(tz: string): string {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      timeZoneName: "short",
    }).formatToParts(new Date());
    const short = parts.find((p) => p.type === "timeZoneName")?.value ?? "";
    if (short && !/^(GMT|UTC)[+-]/.test(short)) return short;
    const longParts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      timeZoneName: "long",
    }).formatToParts(new Date());
    const longName =
      longParts.find((p) => p.type === "timeZoneName")?.value ?? "";
    if (longName === "Coordinated Universal Time") return "UTC";
    const words = longName.split(/\s+/).filter((w) => /^[A-Z]/.test(w));
    return words.length ? words.map((w) => w[0]).join("") : short || tz;
  } catch {
    return tz;
  }
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mb-8">
      <h2 className="m-0 text-[11px] font-semibold tracking-[0.06em] uppercase text-[var(--color-muted)] mb-2.5">
        {title}
      </h2>
      <div className="bg-[var(--color-surface)] border border-[var(--color-rule)] rounded-[10px] overflow-hidden">
        {children}
      </div>
    </section>
  );
}

function SettingsRow({
  label,
  secondary,
  mono,
  children,
}: {
  label: string;
  secondary?: string;
  mono?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="border-b border-[var(--color-rule-soft)] last:border-b-0 px-[18px] py-3.5">
      <div className="flex items-baseline gap-3 mb-0.5 flex-wrap">
        <span
          className={
            mono
              ? "font-mono text-[13px] text-[var(--color-ink)]"
              : "text-[14px] text-[var(--color-ink)] font-medium"
          }
        >
          {label}
        </span>
        {secondary && (
          <span className="font-mono text-[11.5px] text-[var(--color-muted)]">
            {secondary}
          </span>
        )}
      </div>
      <div className="text-[var(--color-ink-soft)] text-[13.5px]">{children}</div>
    </div>
  );
}
