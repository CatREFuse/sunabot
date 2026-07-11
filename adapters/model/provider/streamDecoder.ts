import type { ProviderCompleteOptions, ResponseFunctionCallItem } from "./contracts.js";
import { parseJson } from "./valueUtils.js";

export function extractProviderText(payload: unknown) {
  const outputText = (payload as { output_text?: string }).output_text;
  if (outputText?.trim()) return outputText.trim();
  return extractResponsesText(payload);
}

export async function emitIntermediateAssistantText(
  payload: unknown,
  options: ProviderCompleteOptions,
  fallbackText = ""
) {
  if (!options.onAssistantText) return;
  const text = extractResponsesText(payload) || fallbackText.trim();
  if (!text) return;
  await options.onAssistantText(text);
}

export function extractResponseOutput(payload: unknown) {
  const output = (payload as { output?: unknown[] })?.output;
  return Array.isArray(output)
    ? output.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"))
    : [];
}

export function extractFunctionCalls(payload: unknown) {
  return extractResponseOutput(payload).filter((item): item is ResponseFunctionCallItem => {
    return item.type === "function_call" &&
      typeof item.name === "string" &&
      typeof item.call_id === "string" &&
      typeof item.arguments === "string";
  });
}

export function summarizeResponsesPayload(payload: unknown, rawText: string) {
  const response = payload as {
    status?: unknown;
    error?: unknown;
    incomplete_details?: unknown;
    usage?: unknown;
    output?: Array<Record<string, unknown>>;
  } | null;
  const output = Array.isArray(response?.output) ? response.output : [];
  const imageItems = output.filter((item) => item?.type === "image_generation_call");
  return {
    hasPayload: Boolean(payload),
    rawChars: String(rawText ?? "").length,
    status: typeof response?.status === "string" ? response.status : undefined,
    error: response?.error,
    incompleteDetails: response?.incomplete_details,
    usage: response?.usage,
    outputCount: output.length,
    outputTypes: output.map((item) => String(item?.type ?? "")),
    imageGeneration: imageItems.map((item) => {
      const result = String(item.result ?? item.image ?? item.b64_json ?? item.partial_image_b64 ?? "");
      return {
        status: item.status,
        hasResult: Boolean(result.trim()),
        resultChars: result.length
      };
    }),
    textChars: extractResponsesText(payload).length
  };
}

export function extractResponsesTextFromSse(text: string) {
  let output = "";
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    const payload = parseJson(data);
    if (payload?.type === "response.output_text.delta" && typeof payload.delta === "string") {
      output += payload.delta;
    }
    if (!output && payload?.type === "response.completed") {
      output = extractResponsesText(payload.response);
    }
  }
  return output.trim();
}

export function parseResponsesSsePayload(text: string) {
  const events = parseServerSentEventJson(text);
  if (!events.length) return null;
  const output: unknown[] = [];
  let responsePayload: Record<string, unknown> | null = null;
  let streamError: unknown = null;

  for (const event of events) {
    if (event?.error) streamError = event.error;
    if (event?.response && typeof event.response === "object") {
      responsePayload = event.response as Record<string, unknown>;
    }
    if ((event?.type === "response.output_item.added" || event?.type === "response.output_item.done") && event.item) {
      const index = Number(event.output_index);
      if (Number.isInteger(index) && index >= 0) {
        output[index] = { ...((output[index] as object) ?? {}), ...event.item };
      } else {
        output.push(event.item);
      }
    }
  }

  if (streamError) return { error: streamError };
  return {
    ...(responsePayload ?? {}),
    output: output.filter(Boolean)
  };
}

export function extractResponsesText(payload: unknown) {
  const response = payload as {
    output_text?: string;
    output?: Array<{ type?: string; content?: Array<{ text?: string; type?: string }> }>;
  };
  if (response?.output_text?.trim()) return response.output_text.trim();
  return (response?.output ?? [])
    .flatMap((item) => item.content ?? [])
    .map((item) => item.text ?? "")
    .join("")
    .trim();
}

function parseServerSentEventJson(text: string) {
  return String(text ?? "")
    .split(/\r?\n\r?\n/)
    .map((block) => block.split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n")
      .trim())
    .filter((data) => data && data !== "[DONE]")
    .map((data) => parseJson(data))
    .filter(Boolean) as Array<Record<string, any>>;
}
