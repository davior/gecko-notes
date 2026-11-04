import type { ConversationRequest, FileAttachment } from "@/services/ai";

/**
 * What a turn planned by tool calls needs from the browser (M5).
 *
 * The text plan ships a vendor-shaped request body with the JSON-plan rules baked into its
 * system prompt. The tool planner builds its own prompt on the server, with no format rules,
 * so it needs the neutral parts instead: the same reference block, live note, history and
 * request the text plan was assembled from. Sent beside the usual body, never instead of it,
 * so a server that does not plan by tools (local mode, the switch off) is unaffected.
 */
export interface ToolContext {
  reference_block: string;
  current_note_text: string | null;
  history: { role: string; content: string }[];
  user_request: string;
  attachments: { media_type: string; data: string; name: string }[];
}

export function buildToolContext(
  req: Pick<
    ConversationRequest,
    | "referenceBlock"
    | "currentNoteText"
    | "history"
    | "userRequest"
    | "attachments"
  >,
): ToolContext {
  return {
    reference_block: req.referenceBlock ?? "",
    current_note_text: req.currentNoteText || null,
    history: req.history.map((m) => ({ role: m.role, content: m.content })),
    user_request: req.userRequest,
    attachments: (req.attachments ?? []).map((a) => ({
      media_type: a.mimeType,
      data: a.data,
      name: a.name,
    })),
  };
}

/** Whether a turn may be planned by tools: the person switched it on, and every attachment is
 *  an image. The suite's chat carries images; a PDF goes the text plan's way, to Anthropic. */
export function canPlanWithTools(
  enabled: boolean,
  attachments: FileAttachment[] | undefined,
): boolean {
  return (
    enabled && (attachments ?? []).every((a) => a.mimeType.startsWith("image/"))
  );
}
