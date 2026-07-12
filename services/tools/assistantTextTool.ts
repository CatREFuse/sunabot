export const ASSISTANT_TEXT_TOOL_NAME = "assistant_text";

export const assistantTextTool = {
  type: "function",
  name: ASSISTANT_TEXT_TOOL_NAME,
  description: "Send a short assistant message immediately while continuing the current multi-step action. Use it for meaningful progress updates or questions that help the user follow the work. The final response is still sent normally.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      text: {
        type: "string",
        minLength: 1,
        maxLength: 4_000,
        description: "The assistant message to send now."
      }
    },
    required: ["text"]
  },
  strict: true
} as const;

export function readAssistantText(input: Record<string, unknown>) {
  return String(input.text ?? "").trim().slice(0, 4_000);
}
