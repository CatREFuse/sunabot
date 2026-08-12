import type { KnowledgeSearchInput } from "../knowledge/public.js";

export const KNOWLEDGE_SEARCH_TOOL_NAME = "knowledge_search";
export const KNOWLEDGE_PATH_VERIFICATION_TOOL_INSTRUCTION =
  "A knowledge result path is relative to its knowledge root. Use a local image only from a real Markdown image link or an explicit Workbench-relative path in matched content. Resolve a Markdown image link target against the source document path, prefix knowledge/ exactly once, and verify that exact Workbench path with Bash before passing it to another tool. An explicit Workbench-relative path already starts at the Workbench root and must be used unchanged. Never guess a missing path or add knowledge/ twice.";

export interface KnowledgeSearchToolPort {
  enabled: boolean;
  search(input: KnowledgeSearchInput): Promise<unknown>;
}

export const knowledgeSearchTool = {
  type: "function",
  name: KNOWLEDGE_SEARCH_TOOL_NAME,
  description: `Search the current Agent knowledge base with BM25. Use it for facts, policies, references, notes, and documents that may exist in the managed local knowledge files. Results include the knowledge source path and exact line range. ${KNOWLEDGE_PATH_VERIFICATION_TOOL_INSTRUCTION}`,
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      query: {
        type: "string",
        minLength: 1,
        maxLength: 1_000,
        description: "The knowledge search query. Include the concrete subject and distinguishing terms."
      },
      limit: {
        type: ["integer", "null"],
        minimum: 1,
        maximum: 20,
        description: "Maximum result count from 1 to 20. Use null for the default."
      }
    },
    required: ["query", "limit"]
  },
  strict: true
} as const;
