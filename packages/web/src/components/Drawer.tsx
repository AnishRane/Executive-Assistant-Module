// Generic right-side drawer. Used by MeetingDrawer + TripDrawer
// (and any future drilldown). 420 px wide on desktop, fixed position
// over the day view. Semi-opaque backdrop with click-to-close.
// Closes on ESC. Renders into document.body via portal so the
// existing layout's max-width / overflow rules don't clip it.

import { useEffect } from "react";
import { createPortal } from "react-dom";

interface DrawerProps {
  open: boolean;
  onClose: () => void;
  title: string;
  /** Optional small subtitle line under the title. */
  subtitle?: string | null;
  children: React.ReactNode;
}

export function Drawer({ open, onClose, title, subtitle, children }: DrawerProps) {
  // ESC closes the drawer
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // Lock body scroll while open
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  if (!open) return null;

  return createPortal(
    <div className="fixed inset-0 z-50 flex">
      {/* Backdrop — click closes the drawer */}
      <button
        type="button"
        aria-label="Close drawer"
        onClick={onClose}
        className="flex-1 bg-black/15 cursor-default"
      />

      {/* Drawer panel */}
      <aside
        className="w-[420px] max-w-[100vw] bg-[var(--color-surface)] border-l border-[var(--color-rule)] shadow-md flex flex-col h-full"
        role="dialog"
        aria-label={title}
      >
        <header className="px-5 py-4 border-b border-[var(--color-rule-soft)] flex items-baseline gap-3">
          <div className="flex-1 min-w-0">
            <h2 className="m-0 text-[17px] font-semibold leading-tight text-[var(--color-ink)] truncate">
              {title}
            </h2>
            {subtitle && (
              <div className="text-[12.5px] text-[var(--color-muted)] mt-0.5 truncate">
                {subtitle}
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="border-0 bg-transparent text-[var(--color-muted)] hover:text-[var(--color-ink)] cursor-pointer text-[18px] leading-none px-1"
          >
            ×
          </button>
        </header>
        <div className="flex-1 overflow-y-auto px-5 py-4">{children}</div>
      </aside>
    </div>,
    document.body,
  );
}
