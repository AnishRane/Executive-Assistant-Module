// v0.4.36 — diagnostic trace sink. ALWAYS ON. No env-var gate.
//
// Each line goes to BOTH stderr and an append-mode log file at a
// predictable absolute path. Reinstall the .hebbsmod through the
// admin UI, do a thing, then `cat /tmp/ea-trace.log`.
//
// Override the path via EA_TRACE_FILE if you want — otherwise it's
// /tmp which is universally writable.
//
// Format: ISO timestamp + space + line. Newline-terminated.
// Synchronous append so traces survive even if the process crashes
// mid-run. ~0.1 ms per write — negligible.

import { appendFileSync } from "node:fs";

const TRACE = true; // always on while we're debugging perf
const TRACE_FILE = process.env.EA_TRACE_FILE ?? "/tmp/ea-trace.log";

let firstWrite = true;

export function trace(line: string): void {
  if (!TRACE) return;
  const stamped = `${new Date().toISOString()} ${line}\n`;
  // Live tail.
  process.stderr.write(stamped);
  // Durable copy.
  try {
    if (firstWrite) {
      firstWrite = false;
      appendFileSync(
        TRACE_FILE,
        `\n${new Date().toISOString()} ──── EA_TRACE session start ────\n`,
      );
    }
    appendFileSync(TRACE_FILE, stamped);
  } catch {
    // If the file path is unwritable, keep going — stderr mirror is
    // still recording. Don't break the run for a logging failure.
  }
}

export const TRACE_ENABLED = TRACE;
