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
    "Prefer recording when future consistency could benefit. Do not pre-screen or rewrite the content for first-person wording, trusted salutations, identity markers, or event-schema compliance; later consolidation can review and normalize it.",
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
        description: "The concise working-memory item to retain."
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
