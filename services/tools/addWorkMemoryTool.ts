export const ADD_WORKMEMORY_TOOL_NAME = "add_workmemory";
export const ADD_WORKMEMORY_STABLE_ERROR_CODES = [
  "ADD_WORKMEMORY_INVALID",
  "ADD_WORKMEMORY_UNAVAILABLE",
  "ADD_WORKMEMORY_FAILED",
  "ADD_WORKMEMORY_DECISION_DUPLICATE",
  "WORKING_MEMORY_CONFLICT",
  "WORKING_MEMORY_ITEM_INVALID",
  "WORKING_MEMORY_DOCUMENT_INVALID",
  "WORKING_MEMORY_PATH_INVALID",
  "WORKING_MEMORY_TOO_LARGE"
] as const;

const stableErrorCodes = new Set<string>(ADD_WORKMEMORY_STABLE_ERROR_CODES);

export function isAddWorkMemoryStableErrorCode(value: unknown): value is string {
  return typeof value === "string" && stableErrorCodes.has(value);
}

export interface AddWorkMemoryToolInput {
  action?: "record" | "skip";
  content?: string;
}

export interface AddWorkMemoryToolPort {
  execute(input: AddWorkMemoryToolInput, signal?: AbortSignal): Promise<unknown>;
  decisionRequired?: boolean;
  decisionResolved?(): boolean;
}

export const addWorkMemoryTool = {
  type: "function",
  name: ADD_WORKMEMORY_TOOL_NAME,
  description: [
    "Make exactly one working-memory decision for the current ordinary reply before using other tools or returning visible text.",
    "Use action=record to immediately save a short-lived working memory when information should remain consistent beyond the current conversation context but should not enter long-term memory yet. Use action=skip when this turn contains no useful short-lived memory.",
    "Use it proactively for temporary agreements, current context, the present situation, follow-up priorities, and important information specific to the current conversation field.",
    "When the information is clear, write content as the current Agent's concise first-person natural-language account of one event, naturally including the known time, place or conversation field, people, event, and feelings without turning them into labeled fields or inventing missing details.",
    "Prefer recording when future consistency could benefit. The host does not reject content for perspective, wording, salutations, identity markers, or event-schema style; later consolidation can connect related memories along their internal timeline and rewrite them as a new coherent memory.",
    "When the memory depends on an image, first use export_chat_media when it comes from chat, then use the permitted Bash tool to copy or save the exact image under knowledge/ and create or update a nearby searchable Markdown note so knowledge_search can index it. The note must link or embed the image with a real relative Markdown link whose target is relative to that note, for example ![红色方块参考](red-square.png), rather than leaving a bare path. Store a portable Markdown link in this memory whose target starts with knowledge/ (for example ![红色方块参考](knowledge/references/red-square.png)), rather than a host path, URL, data URI, media handle, or bare path. Later, use that same knowledge/... link target with send_file or as referenceImagePaths for generate_img or selfie.",
    "Provide only the useful content. The host binds the current Agent and conversation source and records the authoritative time."
  ].join(" "),
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      action: {
        type: "string",
        enum: ["record", "skip"],
        description: "record saves one memory item; skip explicitly confirms that this turn has no working-memory candidate."
      },
      content: {
        type: ["string", "null"],
        minLength: 1,
        maxLength: 4_000,
        description: "A concise working-memory item when action=record, or null when action=skip. Image memories include a real Markdown link whose target starts with knowledge/... after the image and a searchable Markdown note with its own relative image link have been saved with Bash."
      }
    },
    required: ["action", "content"]
  },
  strict: true
} as const;

export async function runAddWorkMemory(
  input: unknown,
  port: AddWorkMemoryToolPort,
  signal?: AbortSignal
) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, code: "ADD_WORKMEMORY_INVALID", error: "add_workmemory arguments must be an object." };
  }
  const record = input as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== "action" && key !== "content")) {
    return { ok: false, code: "ADD_WORKMEMORY_INVALID", error: "add_workmemory contains unsupported arguments." };
  }
  const action = record.action;
  if (action !== "record" && action !== "skip") {
    return { ok: false, code: "ADD_WORKMEMORY_INVALID", error: "action must be record or skip." };
  }
  if (action === "skip") {
    if (record.content !== null) {
      return { ok: false, code: "ADD_WORKMEMORY_INVALID", error: "content must be null when action is skip." };
    }
    return port.execute({ action: "skip" }, signal);
  }
  if (
    typeof record.content !== "string"
    || !record.content.trim()
    || Array.from(record.content).length > 4_000
  ) {
    return { ok: false, code: "ADD_WORKMEMORY_INVALID", error: "content must contain 1 to 4000 characters." };
  }
  return port.execute({ action: "record", content: record.content.trim() }, signal);
}
