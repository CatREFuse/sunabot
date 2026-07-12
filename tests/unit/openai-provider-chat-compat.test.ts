// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderConfig, ProviderKind } from "../../src/types.js";

const appendRequestLog = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("../../src/requestLog.js", () => ({ appendRequestLog }));

import { OpenAIProvider } from "../../adapters/model/openaiProvider.js";

afterEach(() => vi.restoreAllMocks());

describe("provider protocols", () => {
  it("uses Chat Completions for OpenAI-compatible providers", async () => {
    const provider = new OpenAIProvider(providerConfig("openai-compatible"));
    const create = vi.fn(async () => ({
      id: "chatcmpl-test",
      object: "chat.completion",
      created: 1,
      model: "compatible-model",
      choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "OK" } }]
    }));
    vi.spyOn(provider as never, "createChatClient").mockReturnValue({ chat: { completions: { create } } });

    await expect(provider.complete("system", [{ role: "user", content: "ping" }], { asyncCodex: true })).resolves.toBe("OK");
    const baseUrl = (provider as unknown as { normalizeChatBaseUrl(): string }).normalizeChatBaseUrl();
    expect(`${baseUrl}/chat/completions`).toBe("https://compatible.example/v1/chat/completions");
    expect(create.mock.calls[0]?.[0]).toMatchObject({ model: "compatible-model", messages: [{ role: "system" }, { role: "user" }] });
    const chatCodex = (create.mock.calls[0]?.[0] as Record<string, any>).tools[0].function;
    expect(chatCodex.parameters.required).toContain("dispatch_message");
  });

  it("uses native Anthropic Messages with image blocks and multi-round tools", async () => {
    const provider = new OpenAIProvider(providerConfig("anthropic-official"));
    vi.spyOn(provider as never, "getApiKey").mockReturnValue("anthropic-key");
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({
        content: [
          { type: "text", text: "处理中" },
          { type: "tool_use", id: "tool-1", name: "assistant_text", input: { text: "处理中" } }
        ],
        stop_reason: "tool_use"
      }))
      .mockResolvedValueOnce(jsonResponse({ content: [{ type: "text", text: "完成" }], stop_reason: "end_turn" }));
    const delivered = vi.fn();

    await expect(provider.complete("system", [{
      role: "user",
      content: "看图",
      imageUrls: ["data:image/png;base64,AAAA"]
    }], { onAssistantText: delivered, asyncCodex: true })).resolves.toBe("完成");
    expect(delivered).toHaveBeenCalledWith("处理中");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://api.anthropic.com/v1/messages");
    const firstBody = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body));
    expect(firstBody.messages[0].content).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "image", source: expect.objectContaining({ media_type: "image/png" }) })
    ]));
    const anthropicCodex = firstBody.tools.find((tool: Record<string, unknown>) => tool.name === "codex");
    expect(anthropicCodex.input_schema.required).toContain("dispatch_message");
    const secondBody = JSON.parse(String((fetchMock.mock.calls[1]?.[1] as RequestInit).body));
    expect(secondBody.messages.at(-1).content[0]).toMatchObject({ type: "tool_result", tool_use_id: "tool-1" });
  });

  it("uses native Gemini generateContent with inline image data", async () => {
    const provider = new OpenAIProvider(providerConfig("gemini-official"));
    vi.spyOn(provider as never, "getApiKey").mockReturnValue("gemini-key");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({
      candidates: [{ content: { role: "model", parts: [{ text: "OK" }] } }],
      usageMetadata: { totalTokenCount: 4 }
    }));

    await expect(provider.complete("system", [{
      role: "user",
      content: "看图",
      imageUrls: ["data:image/png;base64,AAAA"]
    }], { asyncCodex: true })).resolves.toBe("OK");
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/v1beta/models/gemini-2.5-flash:generateContent?key=gemini-key");
    const body = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body));
    expect(body.contents[0].parts).toEqual(expect.arrayContaining([
      expect.objectContaining({ inlineData: { mimeType: "image/png", data: "AAAA" } })
    ]));
    const geminiCodex = body.tools[0].functionDeclarations.find((tool: Record<string, unknown>) => tool.name === "codex");
    expect(geminiCodex.parameters.required).toContain("dispatch_message");
  });

  it("does not route non-Responses providers through image generation", async () => {
    const provider = new OpenAIProvider(providerConfig("openai-compatible"));
    await expect(provider.generateImage("portrait", "1024x1024", "high")).rejects.toThrow(/不支持 Responses 图像生成/);
  });
});

function providerConfig(kind: ProviderKind): ProviderConfig {
  const model = kind.startsWith("anthropic") ? "claude-sonnet-4-6" : kind.startsWith("gemini") ? "gemini-2.5-flash" : "compatible-model";
  return {
    id: kind,
    label: kind,
    kind,
    enabled: true,
    model,
    imageModel: "gpt-image-2",
    baseUrl: kind === "openai-compatible" ? "https://compatible.example/v1" : undefined,
    apiKeyEnv: `${kind.replace(/-/g, "_").toUpperCase()}_API_KEY`,
    temperature: 0.2,
    maxOutputTokens: 1024,
    modelSource: "custom",
    multimodal: "auto"
  };
}

function jsonResponse(payload: unknown) {
  return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
}
