// Module-internal shared types.
//
// ParsedLeg used to live in src/parsers/types.ts when the module
// did its own regex-based extraction. We deleted those parsers in
// favour of letting the ea-travel-agent do LLM extraction
// against the inbox item that triage already classified. The shape
// stays the same; the source is now an agent's LLM, not regex.

export interface ParsedLeg {
  kind: "flight" | "hotel" | "ground";
  provider: string;
  /** PNR / reservation number. The natural dedup key for trip_legs. */
  confirmationCode: string | null;
  /** ISO 8601 if known, null otherwise. */
  startsAt: string | null;
  endsAt: string | null;
  originLocation: string | null;
  destinationLocation: string | null;
  /** Per-kind structured payload — flight number, gate, room type, etc. */
  currentState: Record<string, unknown>;
  /** Hint for grouping legs into trips. */
  tripHint: {
    destination: string | null;
    startsOn: string | null; // ISO date (YYYY-MM-DD)
    endsOn: string | null;
  };
}
