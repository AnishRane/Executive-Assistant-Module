// KindChip — small colored chip that labels a calendar item's kind.
// Used by FocusCard (Now/Next) and LaterList rows. Color palette is
// muted/HNWI; chips are decorative, not interactive.
//
// v0.4.29 (Phase 2 of the categorization rollout). The taxonomy is
// locked in docs/categorization-design.md.

export type ItemKindUi =
  | "meeting"
  | "event"
  | "task"
  | "trip_leg"
  | "ooo"
  | "untagged";

interface KindMeta {
  label: string;
  // Inline styles instead of Tailwind so the palette is colocated and
  // doesn't depend on theme tokens.
  bg: string;
  fg: string;
}

const KIND_META: Record<ItemKindUi, KindMeta> = {
  meeting:  { label: "Meeting",  bg: "#ebe6f5", fg: "#4d3f6a" },
  event:    { label: "Event",    bg: "#f3e9d4", fg: "#6b4f25" },
  task:     { label: "Task",     bg: "#dde9e1", fg: "#2f4f3f" },
  trip_leg: { label: "Travel",   bg: "#d9e3ec", fg: "#345268" },
  ooo:      { label: "Out",      bg: "#ecdada", fg: "#6b3030" },
  untagged: { label: "Item",     bg: "#ebe7e0", fg: "#6a6a6e" },
};

export function kindLabel(kind: ItemKindUi): string {
  return KIND_META[kind].label;
}

interface KindChipProps {
  kind: ItemKindUi;
  /** Smaller chip variant for inline-row use (LaterList). */
  size?: "default" | "compact";
}

export function KindChip({ kind, size = "default" }: KindChipProps) {
  const meta = KIND_META[kind];
  const padding = size === "compact" ? "2px 6px 1px" : "3px 8px 2px";
  const fontSize = size === "compact" ? "9.5px" : "10.5px";
  return (
    <span
      style={{
        display: "inline-block",
        backgroundColor: meta.bg,
        color: meta.fg,
        fontSize,
        fontWeight: 600,
        letterSpacing: "0.08em",
        textTransform: "uppercase",
        padding,
        borderRadius: 4,
        lineHeight: 1,
        whiteSpace: "nowrap",
      }}
    >
      {meta.label}
    </span>
  );
}
