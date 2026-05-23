// Small label chip used for "Imminent", "Changed", "OOO",
// "Double-booked", etc. Shell-native styling: Inter (not mono),
// 11 px uppercase tracking-wide. Variants use shell's status palette.

import type { ReactNode } from "react";

type Variant = "imminent" | "changed" | "flagged" | "conflict" | "neutral";

const styles: Record<Variant, string> = {
  imminent: "bg-[var(--color-amber-soft)] text-[var(--color-accent)] border border-[var(--color-accent)]",
  changed: "bg-[var(--color-amber-soft)] text-[var(--color-accent)] border border-[var(--color-accent)]",
  flagged: "bg-[var(--color-paper-warm)] text-[var(--color-ink-soft)] border border-[var(--color-rule)]",
  conflict: "bg-[var(--color-red-soft)] text-[var(--color-conflict)] border border-[var(--color-conflict)]",
  neutral: "bg-[var(--color-paper-warm)] text-[var(--color-ink-soft)] border border-[var(--color-rule)]",
};

export function Badge({
  variant = "neutral",
  children,
}: {
  variant?: Variant;
  children: ReactNode;
}) {
  return (
    <span
      className={`inline-block text-[10px] font-semibold tracking-[0.08em] uppercase px-1.5 py-[1px] rounded-[3px] align-middle ${styles[variant]}`}
    >
      {children}
    </span>
  );
}
