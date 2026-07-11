import type { ChatMessage, ProviderConfig } from "../../../src/types.js";
import type { RenderedPromptRequest } from "../../../services/agent/promptSystem.js";
import { isRecord } from "./valueUtils.js";

export function legacyPromptRequest(systemPrompt: string, messages: ChatMessage[]): RenderedPromptRequest {
  return {
    messages: [{ role: "system", content: systemPrompt }, ...messages],
    response_format: { type: "text" }
  };
}

export function promptRequestFields(request: RenderedPromptRequest) {
  const fields = { ...request } as Record<string, unknown>;
  delete fields.messages;
  delete fields.tools;
  delete fields.response_format;
  delete fields.input;
  delete fields.instructions;
  return fields;
}

export function responseFormatFields(responseFormat: Record<string, unknown>, existingText: unknown) {
  const type = String(responseFormat.type ?? "text");
  if (type === "text") return {};
  const format = type === "json_schema" && isRecord(responseFormat.json_schema)
    ? { type, ...responseFormat.json_schema }
    : responseFormat;
  return {
    text: {
      ...(isRecord(existingText) ? existingText : {}),
      format
    }
  };
}

export function readToolName(tool: Record<string, unknown>) {
  return String(tool.name ?? tool.type ?? "").trim();
}

export function toChatCompletionTool(tool: Record<string, unknown>) {
  return {
    type: "function" as const,
    function: {
      name: String(tool.name ?? ""),
      description: String(tool.description ?? ""),
      parameters: isRecord(tool.parameters) ? tool.parameters : { type: "object", properties: {} },
      ...(typeof tool.strict === "boolean" ? { strict: tool.strict } : {})
    }
  };
}

export function normalizeGeminiReasoningEffort(effort: ProviderConfig["reasoningEffort"]) {
  return effort && ["minimal", "low", "medium", "high"].includes(effort) ? effort : undefined;
}
