// Dev-only app shell. Mounts react-router + react-query around the
// same slot components the PluginUI registers, so we can iterate
// visually before deploying to a real BoringOS host.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route, Link } from "react-router-dom";
import { Today } from "./slots/Today.js";
import { MeetingDetail } from "./slots/MeetingDetail.js";
import { TripDetail } from "./slots/TripDetail.js";
import { MemoryEvidence } from "./slots/MemoryEvidence.js";
import { Settings } from "./slots/Settings.js";

const client = new QueryClient({
  defaultOptions: { queries: { retry: 1, staleTime: 30_000 } },
});

export function App() {
  return (
    <QueryClientProvider client={client}>
      <BrowserRouter>
        <div className="flex">
          <DevSidebar />
          <main className="flex-1 min-h-screen">
            <Routes>
              <Route path="/" element={<Today />} />
              <Route path="/executive" element={<Today />} />
              <Route path="/executive/meetings/:id" element={<MeetingDetail />} />
              <Route path="/executive/trips/:id" element={<TripDetail />} />
              <Route path="/executive/memory" element={<MemoryEvidence />} />
              <Route path="/executive/settings" element={<Settings />} />
            </Routes>
          </main>
        </div>
      </BrowserRouter>
    </QueryClientProvider>
  );
}

function DevSidebar() {
  // Dev-only sidebar — when EA mounts inside the real BoringOS shell,
  // the shell provides its own chrome and this is unused. We mirror
  // the shell's sidebar idiom (248px, Inter, amber active rail) so
  // the dev preview reads like the real thing.
  return (
    <aside className="w-[248px] border-r border-[var(--color-rule)] min-h-screen p-2 bg-[var(--color-paper)] flex flex-col gap-3">
      <div className="px-3 py-2">
        <div className="font-semibold text-[13px] tracking-[0.04em]">Executive Assistant</div>
        <div className="text-[11px] text-[var(--color-muted)] mt-0.5">david@osnhq.com</div>
      </div>
      <nav className="flex flex-col gap-0.5">
        <div className="px-3 pt-1 pb-1 text-[11px] font-semibold tracking-[0.06em] uppercase text-[var(--color-muted)]">
          Surface
        </div>
        <Link
          to="/executive"
          className="flex items-center gap-2.5 px-3 py-1.5 rounded-md text-sm text-[var(--color-ink-faint)] hover:bg-[var(--color-paper-warm)] hover:text-[var(--color-ink)] transition-colors"
        >
          <span className="w-[18px] text-center text-[var(--color-muted)] text-[14px]">◐</span>
          Today
        </Link>
        <Link
          to="/executive/memory"
          className="flex items-center gap-2.5 px-3 py-1.5 rounded-md text-sm text-[var(--color-ink-faint)] hover:bg-[var(--color-paper-warm)] hover:text-[var(--color-ink)] transition-colors"
        >
          <span className="w-[18px] text-center text-[var(--color-muted)] text-[14px]">◇</span>
          Memory
        </Link>
        <div className="px-3 pt-3 pb-1 text-[11px] font-semibold tracking-[0.06em] uppercase text-[var(--color-muted)]">
          Settings
        </div>
        <Link
          to="/executive/settings"
          className="flex items-center gap-2.5 px-3 py-1.5 rounded-md text-sm text-[var(--color-ink-faint)] hover:bg-[var(--color-paper-warm)] hover:text-[var(--color-ink)] transition-colors"
        >
          <span className="w-[18px] text-center text-[var(--color-muted)] text-[14px]">⚙</span>
          Settings
        </Link>
      </nav>
    </aside>
  );
}
