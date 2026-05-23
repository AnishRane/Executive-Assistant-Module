// Email anchor tools.
//
// Architecture (post-refactor):
//   - `email_anchors.scan_meetings` — workflow-driven bulk path. Walks
//     a list of recent Gmail messages and anchors any whose thread
//     matches a known meeting. Pure deterministic match — no LLM,
//     no provider knowledge. This is the cheap, high-volume path.
//   - `email_anchors.bind` — agent-driven single-row path. The
//     ea-travel-agent calls this when it has decided an inbox item
//     is travel-related (anchor_kind = travel_confirmation /
//     travel_update) or is otherwise worth anchoring.
//
// Both write to executive_assistant__email_anchors with idempotency
// on (tenant_id, gmail_message_id) via the unique index — duplicate
// calls are safe no-ops.

import { z } from "@boringos/module-sdk";
import type { Tool, ToolContext, ToolResult } from "@boringos/module-sdk";
import { invoke } from "@boringos/agent";
import { eq, and, inArray } from "drizzle-orm";
import { emailAnchors } from "../schema/email_anchors.js";
import { meetings } from "../schema/meetings.js";
import type { EaDeps } from "./deps.js";

interface ScannedMessage {
  gmailMessageId: string;
  gmailThreadId?: string | null;
}

type ScanResult =
  | { messageId: string; action: "skipped"; reason: string }
  | {
      messageId: string;
      action: "anchored";
      anchorKind: "meeting_invite";
      boundEntityKind: "meeting";
      boundEntityId: string;
    };

export function createEmailAnchorTools(deps: EaDeps): Tool[] {
  const scanMeetings: Tool = {
    name: "email_anchors.scan_meetings",
    description:
      "Bulk-anchor messages whose gmail_thread_id matches a known meeting. Deterministic: thread-id equality only — no content parsing. Idempotent on (tenant, message_id).",
    inputs: z.object({
      messages: z.array(
        z.object({
          gmailMessageId: z.string(),
          gmailThreadId: z.string().nullable().optional(),
        }),
      ),
    }),
    async handler(
      input: { messages: ScannedMessage[] },
      ctx: ToolContext,
    ): Promise<ToolResult> {
      const results: ScanResult[] = [];

      const messageIds = input.messages.map((m) => m.gmailMessageId);
      const seenRows = messageIds.length
        ? await deps.db
            .select({ id: emailAnchors.gmailMessageId })
            .from(emailAnchors)
            .where(
              and(
                eq(emailAnchors.tenantId, ctx.tenantId),
                inArray(emailAnchors.gmailMessageId, messageIds),
              ),
            )
        : [];
      const seen = new Set(seenRows.map((r) => r.id));

      for (const msg of input.messages) {
        if (seen.has(msg.gmailMessageId)) {
          results.push({
            messageId: msg.gmailMessageId,
            action: "skipped",
            reason: "already_anchored",
          });
          continue;
        }

        if (!msg.gmailThreadId) {
          results.push({
            messageId: msg.gmailMessageId,
            action: "skipped",
            reason: "no_thread_id",
          });
          continue;
        }

        const meetingRow = await deps.db
          .select({ id: meetings.id })
          .from(meetings)
          .where(
            and(
              eq(meetings.tenantId, ctx.tenantId),
              eq(meetings.gmailThreadId, msg.gmailThreadId),
            ),
          )
          .limit(1);

        if (meetingRow.length === 0) {
          results.push({
            messageId: msg.gmailMessageId,
            action: "skipped",
            reason: "no_meeting_match",
          });
          continue;
        }

        await deps.db
          .insert(emailAnchors)
          .values({
            tenantId: ctx.tenantId,
            gmailMessageId: msg.gmailMessageId,
            gmailThreadId: msg.gmailThreadId,
            anchorKind: "meeting_invite",
            boundEntityKind: "meeting",
            boundEntityId: meetingRow[0]!.id,
          })
          .onConflictDoNothing();

        results.push({
          messageId: msg.gmailMessageId,
          action: "anchored",
          anchorKind: "meeting_invite",
          boundEntityKind: "meeting",
          boundEntityId: meetingRow[0]!.id,
        });
      }

      return {
        ok: true,
        result: { data: { processed: results, count: results.length } },
      };
    },
  };

  const bind: Tool = {
    name: "email_anchors.bind",
    description:
      "Bind a single Gmail message to an EA entity (meeting or trip_leg). Called by the ea-travel-agent after it has decided what an inbox item is and persisted any associated trip_leg. Idempotent on (tenant, message_id).",
    inputs: z.object({
      gmailMessageId: z.string(),
      gmailThreadId: z.string().nullable().optional(),
      anchorKind: z.enum([
        "meeting_invite",
        "travel_confirmation",
        "travel_update",
      ]),
      boundEntityKind: z.enum(["meeting", "trip_leg"]),
      boundEntityId: z.string().uuid(),
    }),
    async handler(
      input: {
        gmailMessageId: string;
        gmailThreadId?: string | null;
        anchorKind: "meeting_invite" | "travel_confirmation" | "travel_update";
        boundEntityKind: "meeting" | "trip_leg";
        boundEntityId: string;
      },
      ctx: ToolContext,
    ): Promise<ToolResult> {
      await deps.db
        .insert(emailAnchors)
        .values({
          tenantId: ctx.tenantId,
          gmailMessageId: input.gmailMessageId,
          gmailThreadId: input.gmailThreadId ?? null,
          anchorKind: input.anchorKind,
          boundEntityKind: input.boundEntityKind,
          boundEntityId: input.boundEntityId,
        })
        .onConflictDoNothing();
      return { ok: true, result: { data: { anchored: true } } };
    },
  };

  // ── scan_window — orchestrator ─────────────────────────────────
  //
  // The deterministic `scan_meetings` above takes a `messages` list
  // as input — someone has to fetch that list from Gmail. The v0.2.x
  // workflow tried to do that, badly. This tool collapses fetch +
  // scan into a single self-contained call:
  //
  //   1. Dispatch `google.gmail.list_emails` to pull the recent N
  //      messages from Gmail.
  //   2. Map the response into the (gmailMessageId, gmailThreadId)
  //      pairs scan_meetings expects.
  //   3. Dispatch our own `email_anchors.scan_meetings` against that
  //      list.
  //
  // Fail-soft on missing creds / rate limits — returns `ok: true`
  // with a `skipped` reason rather than throwing.

  interface GmailMessageStub {
    id?: string;
    threadId?: string | null;
  }
  interface ListEmailsResponse {
    data?: { messages?: GmailMessageStub[]; resultSizeEstimate?: number };
    messages?: GmailMessageStub[];
  }

  type ScanSkipReason =
    | "tool_registry_unavailable"
    | "gmail_not_connected"
    | "gmail_upstream_unavailable"
    | "gmail_returned_error";

  function classifyError(msg: string): ScanSkipReason {
    const m = msg.toLowerCase();
    if (m.includes("not connected") || m.includes("no credentials") || m.includes("unauthorized")) {
      return "gmail_not_connected";
    }
    if (m.includes("rate") || m.includes("quota") || m.includes("503") || m.includes("502")) {
      return "gmail_upstream_unavailable";
    }
    return "gmail_returned_error";
  }

  const scanWindow: Tool = {
    name: "email_anchors.scan_window",
    description:
      "Pull recent Gmail messages and anchor any whose thread matches a known meeting. Default maxResults=100. Fail-soft when Gmail isn't connected — returns ok:true with a `skipped` reason rather than throwing.",
    inputs: z.object({
      maxResults: z.number().int().positive().max(500).optional(),
    }),
    async handler(
      input: { maxResults?: number },
      ctx: ToolContext,
    ): Promise<ToolResult> {
      if (!deps.toolRegistry) {
        return {
          ok: true,
          result: {
            data: { anchored: 0, skipped: true, reason: "tool_registry_unavailable" satisfies ScanSkipReason },
          },
        };
      }

      const maxResults = input.maxResults ?? 100;

      const listResult = await invoke<unknown, ListEmailsResponse>(
        { registry: deps.toolRegistry, db: deps.db as unknown as never },
        "google.gmail.list_emails",
        { maxResults },
        { ...ctx, invokedBy: "internal" },
      );

      if (!listResult.ok) {
        const reason = classifyError(listResult.error.message);
        console.warn(
          `[ea.email_anchors.scan_window] skipped — ${reason} (${listResult.error.code}: ${listResult.error.message})`,
        );
        return {
          ok: true,
          result: { data: { anchored: 0, skipped: true, reason, error: listResult.error.message } },
        };
      }

      const messages =
        listResult.result?.data?.messages ?? listResult.result?.messages ?? [];

      if (messages.length === 0) {
        return {
          ok: true,
          result: { data: { anchored: 0, scanned: 0, totalFetched: 0 } },
        };
      }

      // Map into scan_meetings' input shape — only include rows that
      // have a usable gmailMessageId (the list response shouldn't
      // omit it, but be defensive).
      const scanInput = messages
        .filter((m): m is Required<Pick<GmailMessageStub, "id">> & GmailMessageStub => !!m.id)
        .map((m) => ({ gmailMessageId: m.id!, gmailThreadId: m.threadId ?? null }));

      if (scanInput.length === 0) {
        return {
          ok: true,
          result: { data: { anchored: 0, scanned: 0, totalFetched: messages.length } },
        };
      }

      const scanResult = await invoke<unknown, { data: { processed: Array<{ action: string }>; count: number } }>(
        { registry: deps.toolRegistry, db: deps.db as unknown as never },
        "executive-assistant.email_anchors.scan_meetings",
        { messages: scanInput },
        { ...ctx, invokedBy: "internal" },
      );

      if (!scanResult.ok) {
        console.warn(
          `[ea.email_anchors.scan_window] scan_meetings failed: ${scanResult.error.message}`,
        );
        return {
          ok: true,
          result: {
            data: {
              anchored: 0,
              scanned: scanInput.length,
              totalFetched: messages.length,
              skipped: true,
              reason: "scan_meetings_failed",
              error: scanResult.error.message,
            },
          },
        };
      }

      const processed = scanResult.result?.data?.processed ?? [];
      const anchored = processed.filter((p) => p.action === "anchored").length;

      console.log(
        `[ea.email_anchors.scan_window] anchored ${anchored}/${scanInput.length} (fetched ${messages.length}) for tenant ${ctx.tenantId}`,
      );
      return {
        ok: true,
        result: {
          data: {
            anchored,
            scanned: scanInput.length,
            totalFetched: messages.length,
          },
        },
      };
    },
  };

  return [scanMeetings, bind, scanWindow];
}
