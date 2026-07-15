// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderConfig, ProviderKind } from "../../src/types.js";

const appendRequestLog = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("../../src/requestLog.js", () => ({ appendRequestLog }));

import { OpenAIProvider } from "../../adapters/model/openaiProvider.js";

beforeEach(() => {
  appendRequestLog.mockReset();
  appendRequestLog.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("provider protocols", () => {
  it("marks the final leading instruction message for GPT-5.6 OpenAI Responses", async () => {
    const provider = new OpenAIProvider({
      ...providerConfig("openai-official"),
      model: "gpt-5.6-terra"
    });
    const create = vi.fn(async () => ({
      output_text: "OK",
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "OK" }] }],
      usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 0 }, output_tokens: 2, total_tokens: 102 }
    }));
    vi.spyOn(provider as never, "createClient").mockReturnValue({ responses: { create } });

    await expect(provider.completeRequest({
      messages: [
        { role: "system", content: "system rules" },
        { role: "developer", content: "developer rules" },
        { role: "user", content: "ping" }
      ],
      response_format: { type: "text" }
    }, {
      logContext: { stage: "reply", promptFamily: "conversation.reply" }
    })).resolves.toBe("OK");

    const body = create.mock.calls[0]?.[0] as Record<string, any>;
    expect(body.input[0].content[0]).toEqual({ type: "input_text", text: "system rules" });
    expect(body.input[1].content[0]).toEqual({
      type: "input_text",
      text: "developer rules",
      prompt_cache_breakpoint: { mode: "explicit" }
    });
    expect(body.input[2].content[0]).toEqual({ type: "input_text", text: "ping" });
  });

  it("logs every visible SDK retry and disables hidden client retries", async () => {
    appendRequestLog.mockClear();
    const provider = new OpenAIProvider(providerConfig("openai-compatible"));
    const rateLimitError = Object.assign(new Error("rate limited"), { status: 429 });
    const create = vi.fn()
      .mockRejectedValueOnce(rateLimitError)
      .mockResolvedValueOnce({
        id: "chatcmpl-retry",
        object: "chat.completion",
        created: 1,
        model: "compatible-model",
        choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "OK" } }],
        usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 }
      });
    const createChatClient = vi.spyOn(provider as never, "createChatClient")
      .mockReturnValue({ chat: { completions: { create } } });

    await expect(provider.complete("system", [{ role: "user", content: "ping" }], {
      logContext: { conversationId: "group:7", stage: "reply" }
    })).resolves.toBe("OK");

    expect(createChatClient).toHaveBeenCalledWith({ maxRetries: 0 });
    expect(create).toHaveBeenCalledTimes(2);
    const responses = appendRequestLog.mock.calls
      .map(([entry]) => entry as Record<string, any>)
      .filter((entry) => entry.category === "model.response" && entry.action === "chat.completions.complete");
    expect(responses).toEqual([
      expect.objectContaining({
        response: expect.objectContaining({ ok: false, status: 429, willRetry: true }),
        metadata: expect.objectContaining({ conversationId: "group:7", stage: "reply", transportAttempt: 1 })
      }),
      expect.objectContaining({
        response: expect.objectContaining({ ok: true }),
        metadata: expect.objectContaining({ conversationId: "group:7", stage: "reply", transportAttempt: 2 })
      })
    ]);
  });

  it("uses the configured normal reply retry limit for SDK requests", async () => {
    vi.useFakeTimers();
    const provider = new OpenAIProvider(providerConfig("openai-compatible"));
    const retryableError = Object.assign(new Error("temporarily unavailable"), { status: 503 });
    const create = vi.fn()
      .mockRejectedValueOnce(retryableError)
      .mockRejectedValueOnce(retryableError)
      .mockRejectedValueOnce(retryableError)
      .mockResolvedValueOnce({
        id: "chatcmpl-configured-retry",
        object: "chat.completion",
        created: 1,
        model: "compatible-model",
        choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "OK" } }]
      });
    vi.spyOn(provider as never, "createChatClient")
      .mockReturnValue({ chat: { completions: { create } } });

    const completion = provider.complete("system", [{ role: "user", content: "ping" }], {
      modelRequestMaxRetries: 3
    });
    await vi.runAllTimersAsync();

    await expect(completion).resolves.toBe("OK");
    expect(create).toHaveBeenCalledTimes(4);
  });

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

  it("does not start or log an SDK attempt after cancellation", async () => {
    const provider = new OpenAIProvider(providerConfig("openai-compatible"));
    const create = vi.fn();
    vi.spyOn(provider as never, "createChatClient").mockReturnValue({ chat: { completions: { create } } });
    const controller = new AbortController();
    const reason = new Error("cancelled");
    controller.abort(reason);

    await expect(provider.complete("system", [{ role: "user", content: "ping" }], {
      signal: controller.signal
    })).rejects.toBe(reason);

    expect(create).not.toHaveBeenCalled();
    expect(appendRequestLog).not.toHaveBeenCalled();
  });

  it("waits for the SDK Retry-After delay", async () => {
    vi.useFakeTimers();
    const provider = new OpenAIProvider(providerConfig("openai-compatible"));
    const rateLimitError = Object.assign(new Error("rate limited"), {
      status: 429,
      headers: new Headers({ "retry-after": "1" })
    });
    const create = vi.fn()
      .mockRejectedValueOnce(rateLimitError)
      .mockResolvedValueOnce({
        id: "chatcmpl-retry-after",
        object: "chat.completion",
        created: 1,
        model: "compatible-model",
        choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "OK" } }]
      });
    vi.spyOn(provider as never, "createChatClient").mockReturnValue({ chat: { completions: { create } } });

    const completion = provider.complete("system", [{ role: "user", content: "ping" }]);
    await vi.advanceTimersByTimeAsync(0);
    expect(create).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(create).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(completion).resolves.toBe("OK");
    expect(create).toHaveBeenCalledTimes(2);
    expect(appendRequestLog.mock.calls.map(([entry]) => entry).find((entry: any) => (
      entry.category === "model.response" && entry.response?.willRetry
    ))).toMatchObject({ response: { status: 429, retryDelayMs: 1_000 } });
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
    expect(delivered.mock.calls).toEqual([
      ["处理中", "text"],
      ["处理中", "assistant_text"]
    ]);
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
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent");
    expect(new Headers((fetchMock.mock.calls[0]?.[1] as RequestInit).headers).get("x-goog-api-key")).toBe("gemini-key");
    const body = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body));
    expect(body.contents[0].parts).toEqual(expect.arrayContaining([
      expect.objectContaining({ inlineData: { mimeType: "image/png", data: "AAAA" } })
    ]));
    const geminiCodex = body.tools[0].functionDeclarations.find((tool: Record<string, unknown>) => tool.name === "codex");
    expect(geminiCodex.parameters.required).toContain("dispatch_message");
  });

  it.each([
    ["anthropic-official" as const, "anthropic.messages.complete", () => jsonResponse({
      content: [{ type: "text", text: "OK" }],
      stop_reason: "end_turn"
    })],
    ["gemini-official" as const, "gemini.generate-content.complete", () => jsonResponse({
      candidates: [{ content: { role: "model", parts: [{ text: "OK" }] } }]
    })],
    ["codex-responses" as const, "codex.complete", () => codexTextResponse("OK")]
  ])("retries an interrupted %s response body", async (kind, action, successfulResponse) => {
    const provider = new OpenAIProvider(providerConfig(kind));
    vi.spyOn(provider as never, "getApiKey").mockReturnValue("provider-key");
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(interruptedBodyResponse())
      .mockResolvedValueOnce(successfulResponse());

    await expect(provider.complete("system", [{ role: "user", content: "ping" }])).resolves.toBe("OK");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const entries = appendRequestLog.mock.calls
      .map(([entry]) => entry as Record<string, any>)
      .filter((entry) => entry.action === action);
    expect(entries.filter((entry) => entry.category === "model.request")).toHaveLength(2);
    expect(entries.filter((entry) => entry.category === "model.response")).toEqual([
      expect.objectContaining({
        response: expect.objectContaining({ ok: false, error: "terminated", willRetry: true }),
        metadata: expect.objectContaining({ transportAttempt: 1 })
      }),
      expect.objectContaining({
        response: expect.objectContaining({ ok: true }),
        metadata: expect.objectContaining({ transportAttempt: 2 })
      })
    ]);
  });

  it.each([
    ["anthropic-official" as const, () => jsonResponse({
      content: [{ type: "text", text: "OK" }],
      stop_reason: "end_turn"
    })],
    ["gemini-official" as const, () => jsonResponse({
      candidates: [{ content: { role: "model", parts: [{ text: "OK" }] } }]
    })],
    ["codex-responses" as const, () => codexTextResponse("OK")]
  ])("uses the configured normal reply retry limit for %s HTTP requests", async (kind, successfulResponse) => {
    vi.useFakeTimers();
    const provider = new OpenAIProvider(providerConfig(kind));
    vi.spyOn(provider as never, "getApiKey").mockReturnValue("provider-key");
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(new TypeError("network 1"))
      .mockRejectedValueOnce(new TypeError("network 2"))
      .mockRejectedValueOnce(new TypeError("network 3"))
      .mockResolvedValueOnce(successfulResponse());

    const completion = provider.complete("system", [{ role: "user", content: "ping" }], {
      modelRequestMaxRetries: 3
    });
    await vi.runAllTimersAsync();

    await expect(completion).resolves.toBe("OK");
    expect(fetchMock).toHaveBeenCalledTimes(4);
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

function interruptedBodyResponse() {
  return {
    ok: true,
    status: 200,
    headers: new Headers(),
    text: vi.fn(async () => { throw new TypeError("terminated"); })
  } as unknown as Response;
}

function codexTextResponse(text: string) {
  const message = {
    type: "message",
    role: "assistant",
    content: [{ type: "output_text", text }]
  };
  return new Response([
    `data: ${JSON.stringify({ type: "response.output_item.done", output_index: 0, item: message })}`,
    `data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", output: [message] } })}`
  ].join("\n\n"), { status: 200, headers: { "content-type": "text/event-stream" } });
}
