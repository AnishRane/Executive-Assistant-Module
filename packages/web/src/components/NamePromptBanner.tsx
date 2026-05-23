// First-time-setup banner that asks the user what to call them.
// Renders at the top of /executive when preferences.display_name is
// unset. Dismissible (session-scoped via sessionStorage so we don't
// nag across reloads in the same session). Once set, the banner
// disappears for good — the underlying preference, not the dismissal,
// is what controls visibility.

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useDisplayName } from "../hooks/useDossier.js";
import { callTool } from "../lib/api.js";

const DISMISS_KEY = "ea.namePromptDismissed";

export function NamePromptBanner() {
  const { data: displayName, isLoading } = useDisplayName();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [dismissed, setDismissed] = useState(() =>
    typeof window !== "undefined"
      ? window.sessionStorage.getItem(DISMISS_KEY) === "1"
      : false,
  );

  if (isLoading) return null;
  if (displayName) return null;
  if (dismissed) return null;

  async function save() {
    const value = draft.trim();
    if (!value) return;
    setSaving(true);
    try {
      await callTool<
        { key: string; value: Record<string, unknown> },
        { data: unknown }
      >("executive-assistant.preferences.set", {
        key: "display_name",
        value: { name: value },
      });
      // Schema flip: we wrap value in an object so the column is
      // always JSONB. The hook reads .name back out.
      await queryClient.invalidateQueries({
        queryKey: ["ea", "preferences", "display_name"],
      });
    } catch {
      // best-effort
    } finally {
      setSaving(false);
    }
  }

  function dismiss() {
    if (typeof window !== "undefined") {
      window.sessionStorage.setItem(DISMISS_KEY, "1");
    }
    setDismissed(true);
  }

  return (
    <div className="bg-[var(--color-chip-bg-soft)] border-b border-[var(--color-rule-soft)] px-8 py-3">
      <div className="flex items-center gap-4 max-w-[1100px]">
        <div className="text-[13.5px] text-[var(--color-ink-soft)] flex-1">
          What should the agent call you? It will use this occasionally in your day brief.
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
          className="flex items-center gap-2"
        >
          <input
            type="text"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Your first name"
            autoComplete="given-name"
            maxLength={40}
            className="text-[13.5px] text-[var(--color-ink)] bg-[var(--color-surface)] border border-[var(--color-rule)] rounded-md px-2.5 py-1 font-sans focus:outline-none focus:border-[var(--color-accent)] focus:ring-2 focus:ring-[var(--color-accent-tint)] w-[180px]"
          />
          <button
            type="submit"
            disabled={saving || !draft.trim()}
            className="bg-[var(--color-accent)] text-white text-[12.5px] font-medium rounded-md px-3 py-1 hover:bg-[#a04a08] transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {saving ? "Saving…" : "Save"}
          </button>
          <button
            type="button"
            onClick={dismiss}
            className="text-[12.5px] text-[var(--color-muted)] hover:text-[var(--color-ink)] px-2 py-1 cursor-pointer"
            aria-label="Dismiss"
          >
            Not now
          </button>
        </form>
      </div>
    </div>
  );
}
