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

  it("returns a deferred Codex call with the model acknowledgement and does not start a second round", async () => {
    const provider = codexProvider();
    const callArguments = {
      task: "Inspect the repository and report the failing test.",
      kind: "local"
    };
    const fetchMock = mockCodexToken(provider, codexSseResponse([
      assistantMessage("已开始检查，完成后告诉你。"),
      functionCall("codex", "call_codex_ack", callArguments)
    ]));

    const result = await provider.completeTurn("system", [{ role: "user", content: "检查仓库" }], {
      asyncCodex: true
    });

    expect(result).toEqual({
      kind: "deferred",
      acknowledgement: "已开始检查，完成后告诉你。",
      toolCall: {
        name: "codex",
        callId: "call_codex_ack",
        arguments: callArguments
      }
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(toolNames(fetchRequestBody(fetchMock, 0))).toEqual(["codex"]);
  });

  it("keeps the deferred acknowledgement empty when the model emits only a Codex call", async () => {
    const provider = codexProvider();
    const callArguments = {
      task: "Research the release history.",
      kind: "research"
    };
    const fetchMock = mockCodexToken(provider, codexSseResponse([
      functionCall("codex", "call_codex_silent", callArguments)
    ]));

    const result = await provider.completeTurn("system", [{ role: "user", content: "查发布历史" }], {
      asyncCodex: true
    });

    expect(result).toEqual({
      kind: "deferred",
      acknowledgement: "",
      toolCall: {
        name: "codex",
        callId: "call_codex_silent",
        arguments: callArguments
      }
    });
    expect(fetchMock).toHaveBeenCalledOnce();
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
    expect(body.instructions).toBe("模板系统提示词");
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
});

function codexProvider() {
  return new OpenAIProvider(providerConfig());
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
