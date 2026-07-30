export const CODEX_TOOL_NAME = "codex";
export const CODEX_MAX_TASK_CHARS = 32_000;
export const WEBSEARCH_TOOL_NAME = "websearch";
export const MEMORY_RECALL_TOOL_NAME = "memory_recall";

export const codexTool = {
  type: "function",
  name: CODEX_TOOL_NAME,
  description: [
    "Delegate complex local workspace tasks, deep multi-source research or search tasks, and long-form analysis or reasoning to an asynchronous Codex worker.",
    "The worker may modify files inside its selected workspace and is available only for administrator-triggered turns.",
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
        description: "local may inspect and modify workspace files; research performs deep web research; analysis handles long reasoning."
      },
      inputHandles: {
        type: ["array", "null"],
        maxItems: 8,
        uniqueItems: true,
        items: {
          type: "string",
          minLength: 1,
          maxLength: 512,
          pattern: "^message:[0-9]+:(image|file):[0-9]+$"
        },
        description: "Exact media handles from the current or explicitly quoted message. Use null when no media input is needed. The runtime freezes supplied handles as read-only worker inputs before dispatch."
      }
    },
    required: ["task", "kind", "inputHandles"]
  },
  strict: true
} as const;

export const codexControlTool = {
  type: "function",
  name: CODEX_TOOL_NAME,
  description: [
    "Control an asynchronous Codex app-server on this Mac or an administrator-managed SSH host.",
    "List visible Codex sessions, start a workspace maintenance session, or continue an exact session by thread ID.",
    "Started and resumed turns may modify files only inside the selected workspace."
  ].join(" "),
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      action: {
        type: "string",
        enum: ["list_sessions", "start", "resume"],
        description: "List sessions, start a new visible session, or continue an existing session."
      },
      ssh_host: {
        type: ["string", "null"],
        maxLength: 128,
        description: "Configured SSH host or alias. Use null for this Mac."
      },
      task: {
        type: ["string", "null"],
        maxLength: CODEX_MAX_TASK_CHARS,
        description: "Complete maintenance task for start/resume. Use null when listing sessions."
      },
      workspace_path: {
        type: ["string", "null"],
        maxLength: 4_096,
        description: "Absolute project directory on the selected host. Required for start/resume and optional for list filtering."
      },
      thread_id: {
        type: ["string", "null"],
        maxLength: 160,
        description: "Exact Codex thread ID for resume. Use null for start/list."
      },
      query: {
        type: ["string", "null"],
        maxLength: 512,
        description: "Optional title/content search when listing sessions."
      },
      limit: {
        type: ["integer", "null"],
        minimum: 1,
        maximum: 50,
        description: "Maximum sessions to return. Use null for 10."
      }
    },
    required: [
      "action",
      "ssh_host",
      "task",
      "workspace_path",
      "thread_id",
      "query",
      "limit"
    ]
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
