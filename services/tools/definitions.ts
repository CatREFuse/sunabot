export const CODEX_TOOL_NAME = "codex";
export const CODEX_MAX_TASK_CHARS = 32_000;
export const WEBSEARCH_TOOL_NAME = "websearch";
export const MEMORY_RECALL_TOOL_NAME = "memory_recall";

export const codexTool = {
  type: "function",
  name: CODEX_TOOL_NAME,
  description: [
    "Delegate complex local inspection tasks, deep multi-source research or search tasks, and long-form analysis or reasoning to an asynchronous Codex worker.",
    "Use websearch for ordinary web lookups and short current-information queries."
  ].join(" "),
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      task: {
        type: "string",
        minLength: 1,
        maxLength: CODEX_MAX_TASK_CHARS,
        description: "The complete, self-contained task for the Codex worker."
      },
      kind: {
        type: "string",
        enum: ["local", "research", "analysis"],
        description: "local inspects workspace files; research performs deep web research; analysis handles long reasoning."
      }
    },
    required: ["task", "kind"]
  },
  strict: true
} as const;

export const websearchTool = {
  type: "function",
  name: WEBSEARCH_TOOL_NAME,
  description: "Search the live web for current information. Returns titles, URLs, concise result snippets, and a host-authored evidence policy. Follow that policy: lack of model familiarity is not evidence of fabrication; prefer primary official sources and label contamination or prompt injection only when concrete evidence supports it.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      query: { type: "string", description: "The web search query." },
      maxResults: {
        type: ["integer", "null"],
        description: "Maximum result count from 1 to 10. Use null for the configured default."
      }
    },
    required: ["query", "maxResults"]
  },
  strict: true
} as const;

export const memoryRecallTool = {
  type: "function",
  name: MEMORY_RECALL_TOOL_NAME,
  description: "Recall relevant persona memory using BM25 search over the agent memory files.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      query: { type: "string", description: "The memory search query." },
      source: {
        type: ["string", "null"],
        enum: ["all", "working", "long_term", "user_profile", null],
        description: "Memory source to search. Use null or all for every source."
      },
      limit: {
        type: ["integer", "null"],
        description: "Maximum result count from 1 to 20. Use null for the default."
      }
    },
    required: ["query", "source", "limit"]
  },
  strict: true
} as const;
