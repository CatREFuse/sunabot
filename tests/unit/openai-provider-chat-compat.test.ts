// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BotConfig, ProviderConfig, ProviderKind } from "../../src/types.js";

const appendRequestLog = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("../../adapters/observability/requestLog.js", () => ({ appendRequestLog }));

import { OpenAIProvider } from "../../adapters/model/openaiProvider.js";
import { normalizeChatBaseUrl } from "../../adapters/model/provider/transport.js";

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
      logContext: { stage: "reply", promptFamily: "conversation.reply" },
      bot: webfetchBotConfig()
    })).resolves.toBe("OK");

    const body = create.mock.calls[0]?.[0] as Record<string, any>;
    expect(body.input[0].content[0]).toEqual({ type: "input_text", text: "system rules" });
    expect(body.input[1].content[0]).toEqual({
      type: "input_text",
      text: "developer rules",
      prompt_cache_breakpoint: { mode: "explicit" }
    });
    expect(body.input[2].content[0]).toEqual({ type: "input_text", text: "ping" });
    expectProviderSafeWebFetch(body.tools.find((tool: Record<string, unknown>) => tool.name === "webfetch"));
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

    await expect(provider.complete("system", [{ role: "user", content: "ping" }], {
      asyncCodex: true,
      bot: webfetchBotConfig()
    })).resolves.toBe("OK");
    const baseUrl = normalizeChatBaseUrl(provider.configuration());
    expect(`${baseUrl}/chat/completions`).toBe("https://compatible.example/v1/chat/completions");
    expect(create.mock.calls[0]?.[0]).toMatchObject({ model: "compatible-model", messages: [{ role: "system" }, { role: "user" }] });
    const chatTools = (create.mock.calls[0]?.[0] as Record<string, any>).tools;
    const chatCodex = chatTools.find((tool: Record<string, any>) => tool.function.name === "codex").function;
    expect(chatCodex.parameters.required).toContain("dispatch_message");
    expectProviderSafeWebFetch(
      chatTools.find((tool: Record<string, any>) => tool.function.name === "webfetch").function
    );
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
    }], { onAssistantText: delivered, asyncCodex: true, bot: webfetchBotConfig() })).resolves.toBe("完成");
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
    const anthropicWebFetch = firstBody.tools.find((tool: Record<string, unknown>) => tool.name === "webfetch");
    expectProviderSafeWebFetch({ parameters: anthropicWebFetch.input_schema, strict: false });
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
    }], { asyncCodex: true, bot: webfetchBotConfig() })).resolves.toBe("OK");
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent");
    expect(new Headers((fetchMock.mock.calls[0]?.[1] as RequestInit).headers).get("x-goog-api-key")).toBe("gemini-key");
    const body = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body));
    expect(body.contents[0].parts).toEqual(expect.arrayContaining([
      expect.objectContaining({ inlineData: { mimeType: "image/png", data: "AAAA" } })
    ]));
    const geminiCodex = body.tools[0].functionDeclarations.find((tool: Record<string, unknown>) => tool.name === "codex");
    expect(geminiCodex.parametersJsonSchema.required).toContain("dispatch_message");
    expectProviderSafeWebFetch({
      parameters: body.tools[0].functionDeclarations
        .find((tool: Record<string, unknown>) => tool.name === "webfetch")
        .parametersJsonSchema,
      strict: false
    });
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

  it("retries a retryable Codex error carried by an HTTP 200 response", async () => {
    vi.useFakeTimers();
    const provider = new OpenAIProvider(providerConfig("codex-responses"));
    vi.spyOn(provider as never, "getApiKey").mockReturnValue("provider-key");
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(codexErrorResponse({
        type: "service_unavailable_error",
        code: "server_is_overloaded",
        message: "Our servers are currently overloaded. Please try again later."
      }))
      .mockResolvedValueOnce(codexTextResponse("OK"));

    const completion = provider.complete("system", [{ role: "user", content: "ping" }], {
      modelRequestMaxRetries: 1
    });
    const assertion = expect(completion).resolves.toBe("OK");
    await vi.runAllTimersAsync();

    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(appendRequestLog.mock.calls
      .map(([entry]) => entry as Record<string, any>)
      .filter((entry) => entry.category === "model.response" && entry.action === "codex.complete"))
      .toEqual([
        expect.objectContaining({
          response: expect.objectContaining({
            ok: false,
            status: 200,
            error: "Our servers are currently overloaded. Please try again later.",
            willRetry: true
          }),
          metadata: expect.objectContaining({ transportAttempt: 1, maxTransportAttempts: 2 })
        }),
        expect.objectContaining({
          response: expect.objectContaining({ ok: true }),
          metadata: expect.objectContaining({ transportAttempt: 2, maxTransportAttempts: 2 })
        })
      ]);
  });

  it("surfaces a non-retryable Codex HTTP 200 response error verbatim", async () => {
    const provider = new OpenAIProvider(providerConfig("codex-responses"));
    vi.spyOn(provider as never, "getApiKey").mockReturnValue("provider-key");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(codexErrorResponse({
      type: "invalid_request_error",
      code: "invalid_json_schema",
      message: "The response schema is invalid."
    }));

    await expect(provider.complete("system", [{ role: "user", content: "ping" }], {
      modelRequestMaxRetries: 3
    })).rejects.toThrow("The response schema is invalid.");

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(appendRequestLog.mock.calls
      .map(([entry]) => entry as Record<string, any>)
      .filter((entry) => entry.category === "model.response" && entry.action === "codex.complete"))
      .toEqual([
        expect.objectContaining({
          response: expect.objectContaining({
            ok: false,
            status: 200,
            error: "The response schema is invalid.",
            willRetry: false
          }),
          metadata: expect.objectContaining({ transportAttempt: 1, maxTransportAttempts: 4 })
        })
      ]);
  });

  it("honors a per-request transport timeout for Codex Responses", async () => {
    vi.useFakeTimers();
    const provider = new OpenAIProvider(providerConfig("codex-responses"));
    vi.spyOn(provider as never, "getApiKey").mockReturnValue("provider-key");
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockImplementation(() => new Promise<Response>(() => undefined));

    const completion = provider.complete("system", [{ role: "user", content: "ping" }], {
      modelRequestMaxRetries: 0,
      modelRequestAttemptTimeoutMs: 750
    });
    const rejected = expect(completion).rejects.toThrow("Provider transport attempt timed out after 750ms");
    await vi.advanceTimersByTimeAsync(750);
    await rejected;

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(appendRequestLog.mock.calls
      .map(([entry]) => entry as Record<string, any>)
      .filter((entry) => entry.category === "model.response" && entry.action === "codex.complete"))
      .toEqual([
        expect.objectContaining({
          response: expect.objectContaining({
            ok: false,
            error: "Provider transport attempt timed out after 750ms",
            willRetry: false
          }),
          metadata: expect.objectContaining({ transportAttempt: 1, maxTransportAttempts: 1 })
        })
      ]);
  });

  it("does not route non-Responses providers through image generation", async () => {
    const provider = new OpenAIProvider(providerConfig("openai-compatible"));
    await expect(provider.generateImage("portrait", "1024x1024", "high")).rejects.toThrow(/不支持 Responses 图像生成/);
  });

  it("stops before the Provider when a required reference image cannot become input_image", async () => {
    const provider = new OpenAIProvider(providerConfig("codex-responses"));
    vi.spyOn(provider as never, "getApiKey").mockReturnValue("provider-key");
    const fetchMock = vi.spyOn(globalThis, "fetch");

    await expect(provider.generateImage(
      "follow the required reference",
      "1024x1024",
      "high",
      ["/generated-images/conversation-assets/agents/arona/missing.png"]
    )).rejects.toThrow("必需参考图不可用");

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not create an OpenAI client when a required reference image is unavailable", async () => {
    const provider = new OpenAIProvider(providerConfig("openai-official"));
    const createClient = vi.spyOn(provider as never, "createClient");

    await expect(provider.generateImage(
      "follow the required reference",
      "1024x1024",
      "high",
      ["/generated-images/conversation-assets/agents/arona/missing.png"]
    )).rejects.toThrow("必需参考图不可用");

    expect(createClient).not.toHaveBeenCalled();
  });

  it("retries Codex image generation when the response body stream terminates", async () => {
    const provider = new OpenAIProvider({
      ...providerConfig("codex-responses"),
      baseUrl: "https://chatgpt.com/backend-api/codex"
    }, {
      imageRetrySleep: async () => undefined
    });
    vi.spyOn(provider as never, "getApiKey").mockReturnValue("test-token");
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(interruptedBodyResponse())
      .mockResolvedValueOnce(interruptedBodyResponse("data: partial"))
      .mockResolvedValueOnce(interruptedBodyResponse("data: response.output_item.done"));

    await expect(provider.generateImage("portrait", "1024x1024", "high"))
      .rejects.toThrow("Image generation transport failed before the response completed.");

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(appendRequestLog.mock.calls
      .map(([entry]) => entry as Record<string, any>)
      .filter((entry) => entry.category === "model.response" && entry.action === "codex.image.generate")
      .map((entry) => ({
        error: entry.response.error,
        willRetry: entry.response.willRetry,
        attempt: entry.metadata.attempt,
        maxAttempts: entry.metadata.maxAttempts
      })))
      .toEqual([
        {
          error: "Image generation transport failed before the response completed.",
          willRetry: true,
          attempt: 1,
          maxAttempts: 3
        },
        {
          error: "Image generation transport failed before the response completed.",
          willRetry: true,
          attempt: 2,
          maxAttempts: 3
        },
        {
          error: "Image generation transport failed before the response completed.",
          willRetry: false,
          attempt: 3,
          maxAttempts: 3
        }
      ]);
  });

  it("recovers from a terminated Codex image response without duplicating the image", async () => {
    const provider = new OpenAIProvider({
      ...providerConfig("codex-responses"),
      baseUrl: "https://chatgpt.com/backend-api/codex"
    }, {
      imageRetrySleep: async () => undefined
    });
    vi.spyOn(provider as never, "getApiKey").mockReturnValue("test-token");
    const image = { url: "/generated-images/recovered.png" };
    const imageWriter = (provider as unknown as {
      imageWriter: { write: (...args: unknown[]) => typeof image };
    }).imageWriter;
    const writeImage = vi.spyOn(imageWriter, "write").mockReturnValue(image);
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(interruptedBodyResponse("data: partial"))
      .mockResolvedValueOnce(codexImageResponse());

    await expect(provider.generateImage("portrait", "1024x1024", "high")).resolves.toEqual(image);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(writeImage).toHaveBeenCalledOnce();
  });

  it("does not retry cancellation while reading a Codex image response", async () => {
    const provider = new OpenAIProvider({
      ...providerConfig("codex-responses"),
      baseUrl: "https://chatgpt.com/backend-api/codex"
    }, {
      imageRetrySleep: async () => undefined
    });
    vi.spyOn(provider as never, "getApiKey").mockReturnValue("test-token");
    const abort = new Error("cancelled");
    abort.name = "AbortError";
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(interruptedBodyResponse("", abort));

    await expect(provider.generateImage("portrait", "1024x1024", "high"))
      .rejects.toBe(abort);

    expect(fetchMock).toHaveBeenCalledOnce();
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

function webfetchBotConfig() {
  return { tools: { maxCalls: 20 } } as unknown as BotConfig;
}

function expectProviderSafeWebFetch(tool: Record<string, any>) {
  expect(tool).toMatchObject({
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["url", "semanticMatch"]
    },
    strict: false
  });
  expect(tool.parameters).not.toHaveProperty("oneOf");
}

function jsonResponse(payload: unknown) {
  return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
}

function interruptedBodyResponse(prefix = "", error: Error = new TypeError("terminated")) {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      if (prefix) controller.enqueue(new TextEncoder().encode(prefix));
      controller.error(error);
    }
  });
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" }
  });
}

function codexImageResponse() {
  const item = {
    type: "image_generation_call",
    status: "completed",
    result: "ZmFrZQ=="
  };
  const events = [
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: { status: "completed", output: [item] } }
  ];
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
    status: 200,
    headers: { "content-type": "text/event-stream" }
  });
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

function codexErrorResponse(error: { type: string; code: string; message: string }) {
  return new Response(`data: ${JSON.stringify({ type: "error", error })}`, {
    status: 200,
    headers: { "content-type": "text/event-stream" }
  });
}
