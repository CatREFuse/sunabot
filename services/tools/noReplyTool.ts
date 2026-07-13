export const NO_REPLY_TOOL_NAME = "no_reply";

export const noReplyTool = {
  type: "function",
  name: NO_REPLY_TOOL_NAME,
  description: "End the current turn without sending any message. Use it when no response is needed, the conversation has naturally ended, or another bot mention could cause a reply loop. Call this tool by itself before sending any assistant text or calling another tool.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {},
    required: []
  },
  strict: true
} as const;
