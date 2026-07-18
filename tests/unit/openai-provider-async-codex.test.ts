// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BotConfig, ProviderConfig } from "../../src/types.js";
import type { RenderedPromptRequest } from "../../services/agent/promptSystem.js";

const appendRequestLog = vi.hoisted(() => vi.fn(async () => undefined));
const runWebsearch = vi.hoisted(() => vi.fn(async () => ({
  ok: true,
  provider: "test-websearch",
  query: "current weather",
  results: [{ title: "Weather", url: "https://example.test/weather" }]
})));

vi.mock("../../src/requestLog.js", () => ({ appendRequestLog }));
vi.mock("../../adapters/model/webSearchTool.js", () => ({
  WEBSEARCH_TOOL_NAME: "websearch",
  websearchTool: {
    type: "function",
    name: "websearch",
    description: "Search the web.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        query: { type: "string" },
        maxResults: { type: ["integer", "null"] }
      },
      required: ["query", "maxResults"]
    },
    strict: true
  },
  runWebsearch
}));

import { OpenAIProvider } from "../../adapters/model/openaiProvider.js";

describe("OpenAIProvider asynchronous Codex tool turns", () => {
  beforeEach(() => {
    appendRequestLog.mockClear();
    runWebsearch.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses dispatch_message for a deferred Codex call and strips it from worker arguments", async () => {
    const provider = codexProvider();
    const workerArguments = {
      task: "Inspect the repository and report the failing test.",
      kind: "local"
    };
    const callArguments = {
      ...workerArguments,
      dispatch_message: "我已经收到，马上检查仓库。"
    };
    const fetchMock = mockCodexToken(provider, codexSseResponse([
      assistantMessage("这段顶层文本不能替代 dispatch_message。"),
      functionCall("codex", "call_codex_ack", callArguments)
    ]));

    const result = await provider.completeTurn("system", [{ role: "user", content: "检查仓库" }], {
      asyncCodex: true
    });

    expect(result).toEqual({
      kind: "deferred",
      acknowledgement: "我已经收到，马上检查仓库。",
      toolCall: {
        name: "codex",
        callId: "call_codex_ack",
        arguments: workerArguments
      }
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    const firstRequest = fetchRequestBody(fetchMock, 0);
    expect(toolNames(firstRequest)).toEqual(["codex"]);
    expect(firstRequest.prompt_cache_key).toMatch(/^sunabot:[a-f0-9]{48}$/);
    expect(firstRequest.instructions).toBeUndefined();
    expect((firstRequest.input as Array<Record<string, any>>)[0]).toEqual({
      role: "developer",
      content: [{ type: "input_text", text: "system" }]
    });
    const codexDefinition = (firstRequest.tools as Array<Record<string, any>>)[0]!;
    expect(codexDefinition.parameters.required).toContain("dispatch_message");
    expect(codexDefinition.parameters.properties.dispatch_message.maxLength).toBe(200);
  });

  it("returns a tool error and lets the model repair a missing dispatch_message", async () => {
    const provider = codexProvider();
    const workerArguments = {
      task: "Research the release history.",
      kind: "research"
    };
    const fetchMock = mockCodexToken(
      provider,
      codexSseResponse([functionCall("codex", "call_codex_missing", workerArguments)]),
      codexSseResponse([functionCall("codex", "call_codex_repaired", {
        ...workerArguments,
        dispatch_message: "我开始整理发布记录。"
      })])
    );

    const result = await provider.completeTurn("system", [{ role: "user", content: "查发布历史" }], {
      asyncCodex: true
    });

    expect(result).toEqual({
      kind: "deferred",
      acknowledgement: "我开始整理发布记录。",
      toolCall: {
        name: "codex",
        callId: "call_codex_repaired",
        arguments: workerArguments
      }
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchRequestBody(fetchMock, 0).prompt_cache_key).toBe(fetchRequestBody(fetchMock, 1).prompt_cache_key);
    expect((fetchRequestBody(fetchMock, 0).input as unknown[])[0])
      .toEqual((fetchRequestBody(fetchMock, 1).input as unknown[])[0]);
    const repairInput = fetchRequestBody(fetchMock, 1).input as Array<Record<string, unknown>>;
    const errorOutput = repairInput.find((item) => item.type === "function_call_output");
    expect(errorOutput?.call_id).toBe("call_codex_missing");
    expect(JSON.parse(String(errorOutput?.output)).error).toContain("dispatch_message");
  });

  it("does not expose the Codex tool when asynchronous Codex is disabled", async () => {
    const provider = codexProvider();
    const fetchMock = mockCodexToken(provider, codexSseResponse([
      assistantMessage("普通回复")
    ]));

    const result = await provider.completeTurn("system", [{ role: "user", content: "你好" }], {
      asyncCodex: false
    });

    expect(result).toEqual({ kind: "completed", text: "普通回复" });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchRequestBody(fetchMock, 0).tools).toBeUndefined();
  });

  it("executes websearch synchronously and continues to the second model round", async () => {
    const provider = codexProvider();
    const fetchMock = mockCodexToken(
      provider,
      codexSseResponse([
        functionCall("websearch", "call_websearch", {
          query: "current weather",
          maxResults: 2
        })
      ]),
      codexSseResponse([assistantMessage("今天晴，最高 28°C。")])
    );

    const result = await provider.completeTurn("system", [{ role: "user", content: "查天气" }], {
      asyncCodex: true,
      bot: websearchBotConfig()
    });

    expect(result).toEqual({ kind: "completed", text: "今天晴，最高 28°C。" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(toolNames(fetchRequestBody(fetchMock, 0))).toEqual(["websearch", "codex"]);
    expect(runWebsearch).toHaveBeenCalledOnce();
    expect(runWebsearch).toHaveBeenCalledWith({
      query: "current weather",
      maxResults: 2
    }, expect.any(Object), { signal: undefined });

    const secondInput = fetchRequestBody(fetchMock, 1).input as Array<Record<string, unknown>>;
    const output = secondInput.find((item) => item.type === "function_call_output");
    expect(output).toMatchObject({
      type: "function_call_output",
      call_id: "call_websearch"
    });
    expect(JSON.parse(String(output?.output))).toMatchObject({
      ok: true,
      provider: "test-websearch",
      query: "current weather"
    });
  });

  it("delivers assistant_text during a multi-round action and still returns the final text", async () => {
    const provider = codexProvider();
    const onAssistantText = vi.fn(async () => undefined);
    const fetchMock = mockCodexToken(
      provider,
      codexSseResponse([functionCall("assistant_text", "call_assistant_text", { text: "我正在检查。" })]),
      codexSseResponse([assistantMessage("检查完成。")])
    );

    const result = await provider.completeTurn("system", [{ role: "user", content: "检查" }], {
      asyncCodex: false,
      bot: websearchBotConfig(),
      onAssistantText
    });

    expect(result).toEqual({ kind: "completed", text: "检查完成。" });
    expect(onAssistantText).toHaveBeenCalledOnce();
    expect(onAssistantText).toHaveBeenCalledWith("我正在检查。", "assistant_text");
    expect(toolNames(fetchRequestBody(fetchMock, 0))).toContain("assistant_text");
  });

  it("rejects deferred completion after assistant_text was accepted in an earlier round", async () => {
    const provider = codexProvider();
    const onAssistantText = vi.fn(async () => undefined);
    const task = { task: "检查多工具响应", kind: "analysis" };
    const fetchMock = mockCodexToken(
      provider,
      codexSseResponse([
        functionCall("assistant_text", "call_progress", { text: "我先确认一下。" }),
        functionCall("codex", "call_mixed_codex", { ...task, dispatch_message: "我开始检查。" })
      ]),
      codexSseResponse([
        functionCall("codex", "call_single_codex", { ...task, dispatch_message: "我开始检查。" })
      ]),
      codexSseResponse([assistantMessage("检查完成。")])
    );

    const result = await provider.completeTurn("system", [{ role: "user", content: "检查" }], {
      asyncCodex: true,
      onAssistantText
    });

    expect(onAssistantText).toHaveBeenCalledWith("我先确认一下。", "assistant_text");
    expect(result).toEqual({ kind: "completed", text: "检查完成。" });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const thirdInput = fetchRequestBody(fetchMock, 2).input as Array<Record<string, unknown>>;
    const rejected = thirdInput.find((item) => item.type === "function_call_output" && item.call_id === "call_single_codex");
    expect(JSON.parse(String(rejected?.output)).error).toContain("before assistant text or any other tool");
  });

  it("returns an image task dispatch before image generation starts", async () => {
    const provider = codexProvider();
    const generateImage = vi.fn();
    const fetchMock = mockCodexToken(provider, codexSseResponse([
      functionCall("generate_img", "call_image_async", {
        dispatch_message: "我开始画这张月球基地。",
        prompt: "月球基地",
        size: null,
        resolution: "1K",
        quality: "high",
        referenceImageUrls: null
      })
    ]));
    const config = websearchBotConfig();
    config.tools.generateImg = {
      provider: "codex-image-gen",
      size: "1024x1024",
      resolution: "1K",
      quality: "high"
    };

    const result = await provider.completeTurn("system", [{ role: "user", content: "画图" }], {
      bot: config,
      asyncImage: true,
      generateImage
    });

    expect(result).toMatchObject({
      kind: "deferred",
      acknowledgement: "我开始画这张月球基地。",
      toolCall: {
        name: "generate_img",
        callId: "call_image_async",
        arguments: {
          prompt: "月球基地",
          size: null,
          resolution: "1K",
          quality: "high",
          referenceImageUrls: null
        }
      }
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(generateImage).not.toHaveBeenCalled();
  });

  it("never runs an asynchronous image inline when dispatch_message is missing", async () => {
    const provider = codexProvider();
    const generateImage = vi.fn();
    const config = websearchBotConfig();
    config.tools.generateImg = {
      provider: "codex-image-gen",
      size: "1024x1024",
      resolution: "1K",
      quality: "high"
    };
    const fetchMock = mockCodexToken(
      provider,
      codexSseResponse([functionCall("generate_img", "call_image_missing", {
        prompt: "月球基地",
        size: null,
        resolution: "1K",
        quality: "high",
        referenceImageUrls: null
      })]),
      codexSseResponse([assistantMessage("请补充任务后再试。")])
    );

    const result = await provider.completeTurn("system", [{ role: "user", content: "画图" }], {
      bot: config,
      asyncImage: true,
      generateImage
    });

    expect(result).toEqual({ kind: "completed", text: "请补充任务后再试。" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(generateImage).not.toHaveBeenCalled();
  });

  it("dispatches selfie with a persona message and keeps it out of the worker input", async () => {
    const provider = codexProvider();
    const runSelfie = vi.fn();
    const args = {
      prompt: "图书馆窗边的普拉娜",
      size: null,
      resolution: "1K",
      quality: "high",
      referenceImageUrls: null
    };
    const fetchMock = mockCodexToken(provider, codexSseResponse([
      functionCall("selfie", "call_selfie_async", {
        ...args,
        dispatch_message: "我去窗边拍一张，很快回来。"
      })
    ]));

    const result = await provider.completeTurn("system", [{ role: "user", content: "拍张自拍" }], {
      asyncImage: true,
      selfie: { enabled: true, run: runSelfie }
    });

    expect(result).toEqual({
      kind: "deferred",
      acknowledgement: "我去窗边拍一张，很快回来。",
      toolCall: { name: "selfie", callId: "call_selfie_async", arguments: args }
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(runSelfie).not.toHaveBeenCalled();
  });

  it("returns matching visible text and voice as one terminal provider turn", async () => {
    const provider = codexProvider();
    const onToolCall = vi.fn();
    const fetchMock = mockCodexToken(provider, codexSseResponse([
      assistantMessage("おはよう、先生。"),
      functionCall("send_voice_message", "call_voice", {
        text: "おはよう、先生。",
        language: "ja"
      })
    ]));

    const result = await provider.completeTurn("system", [{ role: "user", content: "おはよう" }], {
      voice: { enabled: true, languages: ["ja"], defaultLanguage: "ja" },
      onToolCall
    });

    expect(result).toEqual({
      kind: "completed",
      text: "おはよう、先生。",
      voice: {
        text: "おはよう、先生。",
        language: "ja",
        callId: "call_voice",
        toolName: "send_voice_message"
      }
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(onToolCall).toHaveBeenCalledWith("send_voice_message");
  });

  it("returns dispatch_message and voice together without starting deferred work inline", async () => {
    const provider = codexProvider();
    const fetchMock = mockCodexToken(provider, codexSseResponse([
      functionCall("codex", "call_codex_voice", {
        task: "检查发布包",
        kind: "local",
        dispatch_message: "我会认真把它检查完。"
      }),
      functionCall("send_voice_message", "call_voice", {
        text: "我会认真把它检查完。",
        language: "ja"
      })
    ]));

    await expect(provider.completeTurn("system", [{ role: "user", content: "检查" }], {
      asyncCodex: true,
      voice: { enabled: true, languages: ["ja"], defaultLanguage: "ja" }
    })).resolves.toMatchObject({
      kind: "deferred",
      acknowledgement: "我会认真把它检查完。",
      toolCall: { name: "codex", arguments: { task: "检查发布包", kind: "local" } },
      voice: { language: "ja", callId: "call_voice" }
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("enforces the configured tool call count instead of a fixed round constant", async () => {
    const provider = codexProvider();
    const config = websearchBotConfig();
    config.tools.maxCalls = 1;
    const onAssistantText = vi.fn(async () => undefined);
    mockCodexToken(
      provider,
      codexSseResponse([functionCall("assistant_text", "call_first", { text: "第一步" })]),
      codexSseResponse([functionCall("assistant_text", "call_second", { text: "第二步" })])
    );

    await expect(provider.completeTurn("system", [{ role: "user", content: "执行" }], {
      bot: config,
      onAssistantText
    })).rejects.toThrow("工具调用超过上限：最多 1 次");
    expect(onAssistantText).toHaveBeenCalledTimes(1);
  });

  it("maps the final JSON template fields into the provider request", async () => {
    const provider = codexProvider();
    const fetchMock = mockCodexToken(provider, codexSseResponse([assistantMessage("完成") ]));
    const request: RenderedPromptRequest = {
      messages: [
        { role: "system", content: "模板系统提示词" },
        { role: "user", content: "模板用户输入" }
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "websearch",
            description: "由最终提示词定义的搜索说明",
            parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
            strict: true
          }
        }
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "answer",
          strict: true,
          schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] }
        }
      },
      temperature: 0.1,
      max_output_tokens: 99
    };

    await provider.completeRequest(request, { bot: websearchBotConfig() });

    const body = fetchRequestBody(fetchMock, 0);
    expect(body.instructions).toBeUndefined();
    expect(body.prompt_cache_options).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain("prompt_cache_breakpoint");
    expect((body.input as Array<Record<string, any>>)[0]).toEqual({
      role: "developer",
      content: [{ type: "input_text", text: "模板系统提示词" }]
    });
    expect(body.temperature).toBe(0.1);
    expect(body.max_output_tokens).toBe(99);
    expect(body.tools).toEqual([
      expect.objectContaining({
        type: "function",
        name: "websearch",
        description: "由最终提示词定义的搜索说明"
      })
    ]);
    expect(body.text).toMatchObject({
      format: {
        type: "json_schema",
        name: "answer",
        strict: true
      }
    });
  });

  it("keeps the legacy instructions request shape for models before GPT-5.6", async () => {
    const provider = codexProvider("gpt-5.4-mini");
    const fetchMock = mockCodexToken(provider, codexSseResponse([assistantMessage("完成")]));

    await provider.complete("legacy system", [{ role: "user", content: "ping" }]);

    const body = fetchRequestBody(fetchMock, 0);
    expect(body.instructions).toBe("legacy system");
    expect(body.input).toEqual([{
      role: "user",
      content: [{ type: "input_text", text: "ping" }]
    }]);
  });

  it("uses an implicit stable developer prefix without unsupported explicit fields for GPT-5.6 Codex", async () => {
    const provider = codexProvider();
    const fetchMock = mockCodexToken(provider, codexSseResponse([assistantMessage("完成")]));

    await expect(provider.complete("stable system", [{ role: "user", content: "ping" }])).resolves.toBe("完成");

    const body = fetchRequestBody(fetchMock, 0);
    expect(body.instructions).toBeUndefined();
    expect((body.input as Array<Record<string, any>>)[0]).toEqual({
      role: "developer",
      content: [{ type: "input_text", text: "stable system" }]
    });
  });
});

function codexProvider(model = "gpt-5.6-terra") {
  return new OpenAIProvider({ ...providerConfig(), model });
}

function mockCodexToken(provider: OpenAIProvider, ...responses: Response[]) {
  vi.spyOn(provider as never, "getApiKey").mockReturnValue("test-token");
  return vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
    const response = responses.shift();
    if (!response) throw new Error("Unexpected additional Codex request.");
    return response;
  });
}

function providerConfig(): ProviderConfig {
  return {
    id: "async-codex-provider",
    label: "Async Codex Provider",
    kind: "codex-responses",
    enabled: true,
    model: "gpt-5.6-terra",
    imageModel: "gpt-image-2",
    baseUrl: "https://chatgpt.com/backend-api/codex",
    apiKeyEnv: "SUNABOT_ASYNC_CODEX_TEST_KEY",
    temperature: 0.2,
    maxOutputTokens: 1_200,
    reasoningEffort: "medium"
  };
}

function websearchBotConfig() {
  return {
    tools: {
      maxCalls: 20,
      websearch: {
        provider: "tavily",
        model: "gpt-5.4-mini",
        codexExecutable: "auto",
        tavilyApiKey: "test-key",
        tavilyApiKeyEnv: "TAVILY_API_KEY",
        maxResults: 5
      }
    }
  } as unknown as BotConfig;
}

function codexSseResponse(output: Array<Record<string, unknown>>) {
  const events = output.map((item, outputIndex) => ({
    type: "response.output_item.done",
    output_index: outputIndex,
    item
  }));
  events.push({
    type: "response.completed",
    response: {
      status: "completed",
      output
    }
  } as never);
  const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" }
  });
}

function assistantMessage(text: string) {
  return {
    type: "message",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text }]
  };
}

function functionCall(name: string, callId: string, args: Record<string, unknown>) {
  return {
    type: "function_call",
    name,
    call_id: callId,
    arguments: JSON.stringify(args),
    status: "completed"
  };
}

function fetchRequestBody(fetchMock: ReturnType<typeof vi.spyOn>, index: number) {
  return JSON.parse(String(fetchMock.mock.calls[index]?.[1]?.body)) as Record<string, unknown>;
}

function toolNames(body: Record<string, unknown>) {
  const tools = Array.isArray(body.tools) ? body.tools : [];
  return tools.map((tool) => String((tool as Record<string, unknown>).name ?? ""));
}
