// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderConfig, ProviderKind } from "../../src/types.js";

const appendRequestLog = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("../../src/requestLog.js", () => ({ appendRequestLog }));

import { OpenAIProvider } from "../../adapters/model/openaiProvider.js";

afterEach(() => vi.restoreAllMocks());

describe("OpenAI-compatible chat providers", () => {
  it.each([
    ["gemini-openai", "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions"],
    ["anthropic-openai", "https://api.anthropic.com/v1/chat/completions"]
  ] as const)("uses the official %s Chat Completions endpoint", async (kind, expectedUrl) => {
    const provider = new OpenAIProvider(providerConfig(kind));
    const create = vi.fn(async () => ({
      id: "chatcmpl-test",
      object: "chat.completion",
      created: 1,
      model: providerConfig(kind).model,
      choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "OK" } }]
    }));
    vi.spyOn(provider as never, "createChatClient").mockReturnValue({ chat: { completions: { create } } });

    await expect(provider.complete("system", [{ role: "user", content: "ping" }])).resolves.toBe("OK");
    const baseUrl = (provider as unknown as { normalizeChatBaseUrl(): string }).normalizeChatBaseUrl();
    expect(`${baseUrl}/chat/completions`).toBe(expectedUrl);
    const body = create.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(body).toMatchObject({ model: providerConfig(kind).model, messages: [{ role: "system" }, { role: "user" }] });
  });

  it("does not route compatible chat providers through the Responses image API", async () => {
    const provider = new OpenAIProvider(providerConfig("gemini-openai"));
    await expect(provider.generateImage("portrait", "1024x1024", "high")).rejects.toThrow(/仅支持 Chat Completions/);
  });
});

function providerConfig(kind: ProviderKind): ProviderConfig {
  return {
    id: kind,
    label: kind,
    kind,
    enabled: true,
    model: kind === "gemini-openai" ? "gemini-3.5-flash" : "claude-sonnet-4-6",
    imageModel: "gpt-image-2",
    apiKeyEnv: kind === "gemini-openai" ? "GEMINI_API_KEY" : "ANTHROPIC_API_KEY",
    temperature: 0.2,
    maxOutputTokens: 1024
  };
}
