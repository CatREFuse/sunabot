import type { ProviderConfig } from "../../types";

export type ProviderKind = ProviderConfig["kind"];

export const providerTypeOptions: Array<{
  kind: ProviderKind;
  label: string;
  description: string;
  icon: string;
}> = [
  { kind: "codex-responses", label: "Codex 订阅", description: "使用本机 Codex 登录状态", icon: "bx-terminal" },
  { kind: "openai-official", label: "OpenAI 官方", description: "OpenAI Responses API", icon: "bx-bot" },
  { kind: "anthropic-official", label: "Anthropic 官方", description: "Anthropic Messages API", icon: "bx-message-rounded-detail" },
  { kind: "gemini-official", label: "Gemini 官方", description: "Google generateContent API", icon: "bx-diamond" },
  { kind: "openai-compatible", label: "OpenAI 兼容", description: "兼容 Chat Completions 的服务", icon: "bx-transfer" },
  { kind: "anthropic-compatible", label: "Anthropic 兼容", description: "兼容 Messages API 的服务", icon: "bx-transfer-alt" },
  { kind: "gemini-compatible", label: "Gemini 兼容", description: "兼容 generateContent 的服务", icon: "bx-shape-circle" }
];

export function providerType(kind: ProviderKind) {
  return providerTypeOptions.find((item) => item.kind === kind) ?? providerTypeOptions[0]!;
}

export function compatibleProvider(kind: ProviderKind) {
  return kind.endsWith("-compatible");
}

export function providerPreset(kind: ProviderKind, id: string): ProviderConfig {
  const meta = providerType(kind);
  const values: Record<ProviderKind, Pick<ProviderConfig, "model" | "baseUrl" | "apiKeyEnv" | "modelSource">> = {
    "codex-responses": { model: "gpt-5.5", baseUrl: "https://chatgpt.com/backend-api/codex", apiKeyEnv: "CODEX_ACCESS_TOKEN", modelSource: "remote" },
    "openai-official": { model: "gpt-5.5", baseUrl: "https://api.openai.com", apiKeyEnv: "OPENAI_API_KEY", modelSource: "remote" },
    "anthropic-official": { model: "claude-sonnet-4-6", baseUrl: "https://api.anthropic.com/v1", apiKeyEnv: "ANTHROPIC_API_KEY", modelSource: "remote" },
    "gemini-official": { model: "gemini-2.5-flash", baseUrl: "https://generativelanguage.googleapis.com/v1beta", apiKeyEnv: "GEMINI_API_KEY", modelSource: "remote" },
    "openai-compatible": { model: "model-id", baseUrl: "http://127.0.0.1:8000/v1", apiKeyEnv: "OPENAI_COMPATIBLE_API_KEY", modelSource: "custom" },
    "anthropic-compatible": { model: "model-id", baseUrl: "http://127.0.0.1:8000/v1", apiKeyEnv: "ANTHROPIC_COMPATIBLE_API_KEY", modelSource: "custom" },
    "gemini-compatible": { model: "model-id", baseUrl: "http://127.0.0.1:8000/v1beta", apiKeyEnv: "GEMINI_COMPATIBLE_API_KEY", modelSource: "custom" }
  };
  return {
    id,
    label: meta.label,
    kind,
    enabled: true,
    imageModel: "gpt-image-2",
    envFile: "workspace/secrets/runtime.env",
    temperature: 0.7,
    maxOutputTokens: 8192,
    reasoningEffort: "medium",
    multimodal: "auto",
    ...values[kind]
  };
}
