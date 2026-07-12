import { MODEL_CATALOG } from "../../src/admin/models.js";
import type { ProviderConfig } from "../../src/types.js";
import { OpenAIProvider } from "./openaiProvider.js";
import {
  normalizeAnthropicBaseUrl,
  normalizeChatBaseUrl,
  normalizeGeminiBaseUrl,
  normalizeOpenAiBaseUrl,
  resolveProviderApiKey
} from "./provider/transport.js";
import { isRecord, parseJson } from "./provider/valueUtils.js";

const PROBE_IMAGE = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgAQMAAABJtOi3AAAAA1BMVEX/AAAZ4gk3AAAADElEQVQI12NgGNwAAACgAAFhJX1HAAAAAElFTkSuQmCC";
type VisionProbeCompletion = (system: string, messages: Array<{ role: "user"; content: string; imageUrls: string[] }>) => Promise<string>;

export async function discoverProviderModels(provider: ProviderConfig) {
  if (provider.kind === "codex-responses") return MODEL_CATALOG.map((model) => model.id);
  const apiKey = resolveProviderApiKey(provider);
  if (!apiKey) throw new Error(`Missing API key. Set ${provider.apiKeyEnv}.`);
  if (provider.kind === "anthropic-official" || provider.kind === "anthropic-compatible") {
    return modelIds(await fetchJson(`${normalizeAnthropicBaseUrl(provider.baseUrl)}/models`, {
      headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" }
    }), "data");
  }
  if (provider.kind === "gemini-official" || provider.kind === "gemini-compatible") {
    const payload = await fetchJson(`${normalizeGeminiBaseUrl(provider.baseUrl)}/models?key=${encodeURIComponent(apiKey)}`, {
      headers: { "x-goog-api-key": apiKey }
    });
    return modelIds(payload, "models").map((id) => id.replace(/^models\//, ""));
  }
  const baseUrl = provider.kind === "openai-official"
    ? normalizeOpenAiBaseUrl(provider.baseUrl)
    : normalizeChatBaseUrl(provider);
  return modelIds(await fetchJson(`${baseUrl}/models`, {
    headers: { authorization: `Bearer ${apiKey}` }
  }), "data");
}

export async function probeProviderMultimodal(
  provider: ProviderConfig,
  complete: VisionProbeCompletion = (system, messages) => new OpenAIProvider(provider).complete(system, messages)
) {
  try {
    const result = await complete(
      "识别输入图片的主色，只返回一个大写英文颜色单词。",
      [{ role: "user", content: "这张图片的主色是什么？", imageUrls: [PROBE_IMAGE] }]
    );
    if (/\bRED\b/i.test(result)) return { multimodal: true };
    return { multimodal: false, reason: `模型未识别探测图片：${result.trim().slice(0, 120) || "空响应"}` };
  } catch (error) {
    return { multimodal: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

async function fetchJson(url: string, init: RequestInit) {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(15_000) });
  const text = await response.text();
  const payload = parseJson(text);
  if (!response.ok) {
    const message = isRecord(payload) && isRecord(payload.error) && payload.error.message
      ? String(payload.error.message)
      : `模型目录读取失败：HTTP ${response.status}`;
    throw new Error(message);
  }
  return payload;
}

function modelIds(payload: unknown, field: string) {
  const records = isRecord(payload) && Array.isArray(payload[field]) ? payload[field].filter(isRecord) : [];
  return [...new Set(records.map((record) => String(record.id ?? record.name ?? "").trim()).filter(Boolean))]
    .sort((left, right) => left.localeCompare(right));
}
