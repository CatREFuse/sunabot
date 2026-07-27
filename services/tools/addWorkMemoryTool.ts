export const ADD_WORKMEMORY_TOOL_NAME = "add_workmemory";

export interface AddWorkMemoryToolInput {
  content: string;
}

export interface AddWorkMemoryToolPort {
  execute(input: AddWorkMemoryToolInput, signal?: AbortSignal): Promise<unknown>;
}

export const addWorkMemoryTool = {
  type: "function",
  name: ADD_WORKMEMORY_TOOL_NAME,
  description: [
    "Immediately record a short-lived working memory whenever information should remain consistent beyond the current conversation context but should not enter long-term memory yet.",
    "Use it proactively for temporary agreements, current context, the present situation, follow-up priorities, and important information specific to the current conversation field.",
    "When the information is clear, write content as the current Agent's concise first-person natural-language account of one event, naturally including the known time, place or conversation field, people, event, and feelings without turning them into labeled fields or inventing missing details.",
    "Prefer recording when future consistency could benefit. The host does not reject content for perspective, wording, salutations, identity markers, or event-schema style; later consolidation can connect related memories along their internal timeline and rewrite them as a new coherent memory.",
    "When the memory depends on an image, first use export_chat_media when it comes from chat, then use the permitted Bash tool to copy or save the exact image under knowledge/ and create or update a nearby searchable Markdown note so knowledge_search can index it. Store only the portable knowledge/... relative image link in this memory. Later, use that same relative path with send_file or as referenceImagePaths for generate_img or selfie.",
    "Provide only the useful content. The host binds the current Agent and conversation source and records the authoritative time."
  ].join(" "),
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      content: {
        type: "string",
        minLength: 1,
        maxLength: 4_000,
        description: "The concise working-memory item to retain. Image memories use a portable knowledge/... relative link after the image and its searchable Markdown note have been saved with Bash."
      }
    },
    required: ["content"]
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
  if (Object.keys(record).some((key) => key !== "content")) {
    return { ok: false, code: "ADD_WORKMEMORY_INVALID", error: "add_workmemory contains unsupported arguments." };
  }
  if (typeof record.content !== "string" || !record.content.trim() || record.content.length > 4_000) {
    return { ok: false, code: "ADD_WORKMEMORY_INVALID", error: "content must contain 1 to 4000 characters." };
  }
  return port.execute({ content: record.content.trim() }, signal);
}
