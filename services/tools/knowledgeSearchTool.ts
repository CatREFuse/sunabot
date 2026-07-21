import type { KnowledgeSearchInput } from "../knowledge/public.js";

export const KNOWLEDGE_SEARCH_TOOL_NAME = "knowledge_search";

export interface KnowledgeSearchToolPort {
  enabled: boolean;
  search(input: KnowledgeSearchInput): Promise<unknown>;
}

export const knowledgeSearchTool = {
  type: "function",
  name: KNOWLEDGE_SEARCH_TOOL_NAME,
  description: "Search the current Agent knowledge base with BM25. Use it for facts, policies, references, notes, and documents that may exist in the managed local knowledge files. Results include the source path and exact line range.",
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
