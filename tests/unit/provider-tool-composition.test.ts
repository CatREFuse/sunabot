// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderCompleteOptions } from "../../adapters/model/openaiProvider.js";
import type { ProviderConfig, ProviderKind } from "../../src/types.js";

const appendRequestLog = vi.hoisted(() => vi.fn(async () => undefined));
const runWebsearch = vi.hoisted(() => vi.fn(async () => ({ ok: true, items: [] })));

vi.mock("../../adapters/observability/requestLog.js", () => ({ appendRequestLog }));
vi.mock("../../adapters/model/webSearchTool.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../adapters/model/webSearchTool.js")>(),
  runWebsearch
}));

import { OpenAIProvider } from "../../adapters/model/openaiProvider.js";
import { processProviderToolRound } from "../../adapters/model/provider/toolRound.js";
import { ADD_WORKMEMORY_TOOL_NAME } from "../../services/tools/addWorkMemoryTool.js";
import { ADD_USER_PROFILE_TOOL_NAME } from "../../services/tools/addUserProfileTool.js";

const MCP_FIRST_TOOL_NAME = `mcp_${"a".repeat(48)}`;
const MCP_SECOND_TOOL_NAME = `mcp_${"b".repeat(48)}`;

const PROVIDERS = [
  ["OpenAI Responses", "openai-official"],
  ["Codex Responses", "codex-responses"],
  ["Chat Completions", "openai-compatible"],
  ["Anthropic Messages", "anthropic-official"],
  ["Gemini generateContent", "gemini-official"]
] as const;

afterEach(() => {
  vi.restoreAllMocks();
  appendRequestLog.mockClear();
  runWebsearch.mockClear();
});

describe("Provider tool composition", () => {
  it.each(PROVIDERS)("accepts free text from a persisted schema template on %s", async (
    _providerLabel,
    kind
  ) => {
    const provider = new OpenAIProvider(providerConfig(kind));
    const transport = installRounds(provider, kind, [{ text: "不符合旧 JSON 格式的正常正文。" }]);
    const request = {
      messages: [{ role: "user" as const, content: "给我正常回复" }],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "old_contract",
          strict: true,
          schema: { type: "object", additionalProperties: false, required: ["answer"], properties: { answer: { type: "string", maxLength: 1 } } }
        }
      },
      text: { verbosity: "low", format: { type: "json_schema", strict: true, schema: { type: "object" } } }
    };

    await expect(provider.completeRequest(request)).resolves.toBe("不符合旧 JSON 格式的正常正文。");

    const body = transport.requestBody();
    expect(body.response_format).toBeUndefined();
    expect(body.text?.format).toBeUndefined();
    expect(body.generationConfig?.responseMimeType).toBeUndefined();
    expect(request.response_format.json_schema.strict).toBe(true);
    if (kind === "openai-official" || kind === "codex-responses") {
      expect(body.text).toEqual({ verbosity: "low" });
    }
  });

  it.each(PROVIDERS)("lets the model choose working memory and user profile tools on %s", async (
    _providerLabel,
    kind
  ) => {
    const provider = new OpenAIProvider(providerConfig(kind));
    const transport = installRounds(provider, kind, [
      {
        calls: [{
          name: ADD_WORKMEMORY_TOOL_NAME,
          args: { action: "skip", content: null }
        }]
      },
      {
        text: "这轮已经处理好了。",
        calls: [{
          name: ADD_USER_PROFILE_TOOL_NAME,
          args: { action: "skip", profile: null, addressNames: null }
        }]
      },
      { text: "最终回复。" }
    ]);
    const effects = sideEffects();
    let workmemoryResolved = false;
    let profileResolved = false;
    const options: ProviderCompleteOptions = {
      ...effects.options,
      workingMemory: {
        decisionRequired: true,
        decisionResolved: () => workmemoryResolved,
        execute: vi.fn(async () => {
          workmemoryResolved = true;
          return { ok: true, action: "skip" };
        })
      },
      userProfile: {
        decisionRequired: true,
        decisionResolved: () => profileResolved,
        execute: vi.fn(async () => {
          profileResolved = true;
          return { ok: true, action: "skip" };
        })
      }
    };

    await expect(provider.completeTurn(
      "system",
      [{ role: "user", content: "普通回复" }],
      options
    )).resolves.toEqual({ kind: "completed", text: "最终回复。" });

    expectNoForcedToolChoice(transport.requestBody(0));
    expectNoForcedToolChoice(transport.requestBody(1));
  });

  it.each(PROVIDERS)("delivers sibling text while an optional working-memory decision runs on %s", async (
    _providerLabel,
    kind
  ) => {
    const provider = new OpenAIProvider(providerConfig(kind));
    const transport = installRounds(provider, kind, [{
      text: "这轮已经处理好了。",
      calls: [{
        name: ADD_WORKMEMORY_TOOL_NAME,
        args: { action: "skip", content: null }
      }]
    }, { text: "最终回复。" }]);
    const effects = sideEffects();
    let resolved = false;
    const execute = vi.fn(async () => {
      resolved = true;
      return { ok: true, action: "skip" };
    });
    const options: ProviderCompleteOptions = {
      ...effects.options,
      workingMemory: {
        decisionRequired: true,
        decisionResolved: () => resolved,
        execute
      }
    };

    await expect(provider.completeTurn(
      "system",
      [{ role: "user", content: "普通回复" }],
      options
    )).resolves.toEqual({ kind: "completed", text: "最终回复。" });

    expect(execute).toHaveBeenCalledWith({ action: "skip" }, undefined);
    expectNoForcedToolChoice(transport.requestBody());
    expect(effects.onAssistantText).toHaveBeenCalledOnce();
  });

  it.each(PROVIDERS)("accepts a visible reply without a working-memory decision on %s", async (
    _providerLabel,
    kind
  ) => {
    const provider = new OpenAIProvider(providerConfig(kind));
    installRounds(provider, kind, [{ text: "遗漏了记忆决策。" }]);
    const effects = sideEffects();
    const options: ProviderCompleteOptions = {
      ...effects.options,
      workingMemory: {
        decisionRequired: true,
        decisionResolved: () => false,
        execute: vi.fn()
      }
    };

    await expect(provider.completeTurn(
      "system",
      [{ role: "user", content: "普通回复" }],
      options
    )).resolves.toEqual({ kind: "completed", text: "遗漏了记忆决策。" });
    expect(effects.onAssistantText).not.toHaveBeenCalled();
  });

  it.each(PROVIDERS)("accepts terminal no_reply without a working-memory decision on %s", async (
    _providerLabel,
    kind
  ) => {
    const provider = new OpenAIProvider(providerConfig(kind));
    installRounds(provider, kind, [{
      calls: [{ name: "no_reply", args: {} }]
    }]);
    const effects = sideEffects();
    const options: ProviderCompleteOptions = {
      ...effects.options,
      workingMemory: {
        decisionRequired: true,
        decisionResolved: () => false,
        execute: vi.fn()
      }
    };

    await expect(provider.completeTurn(
      "system",
      [{ role: "user", content: "保持静默" }],
      options
    )).resolves.toEqual({ kind: "no_reply" });
    expect(effects.onAssistantText).not.toHaveBeenCalled();
  });

  it.each([
    "companion",
    "deferred",
    "no_reply"
  ] as const)("returns a %s terminal branch without requiring a memory decision", async (branch) => {
    const terminalCall = {
      type: "function_call" as const,
      call_id: `call-${branch}`,
      name: branch === "companion" ? "send_voice_message" : branch === "deferred" ? "codex" : "no_reply",
      arguments: "{}"
    };
    const executor = {
      resolveDefinitions: () => [],
      companionTurn: () => branch === "companion"
        ? { kind: "completed" as const, text: "语音回复" }
        : null,
      deferredTurn: () => branch === "deferred"
        ? {
            kind: "deferred" as const,
            acknowledgement: "已开始",
            toolCall: {
              name: "codex",
              callId: terminalCall.call_id,
              arguments: {}
            }
          }
        : null,
      noReplyTurn: async () => branch === "no_reply"
        ? { kind: "no_reply" as const }
        : null,
      execute: async () => []
    };

    await expect(processProviderToolRound({
      calls: [terminalCall],
      siblingText: "",
      options: {
        workingMemory: {
          decisionRequired: true,
          decisionResolved: () => false,
          execute: vi.fn()
        }
      },
      definitions: [],
      state: {
        toolCallCount: 0,
        assistantTextSent: false,
        assistantTextDeliveryCount: 0,
        acceptedToolNames: []
      },
      executor,
      emitAssistantText: async () => undefined
    })).resolves.toMatchObject({
      terminal: { kind: branch === "companion" ? "completed" : branch }
    });
  });

  it.each(PROVIDERS)("keeps optional memory calls outside maxCalls=1 on %s", async (
    _providerLabel,
    kind
  ) => {
    const provider = new OpenAIProvider(providerConfig(kind));
    installRounds(provider, kind, [
      {
        calls: [{
          name: ADD_WORKMEMORY_TOOL_NAME,
          args: { action: "skip", content: null }
        }]
      },
      { calls: [{ name: "read_file", args: { path: "safe.txt" } }] },
      { text: "读取完成。" }
    ]);
    const effects = sideEffects();
    let resolved = false;
    const options: ProviderCompleteOptions = {
      ...effects.options,
      bot: {
        ...effects.options.bot,
        tools: {
          ...effects.options.bot?.tools,
          maxCalls: 1
        }
      } as never,
      workingMemory: {
        decisionRequired: true,
        decisionResolved: () => resolved,
        execute: vi.fn(async () => {
          resolved = true;
          return { ok: true, action: "skip" };
        })
      }
    };

    await expect(provider.completeTurn(
      "system",
      [{ role: "user", content: "读取文件" }],
      options
    )).resolves.toEqual({ kind: "completed", text: "读取完成。" });
    expect(effects.read).toHaveBeenCalledOnce();
  });

  it.each(PROVIDERS)("records a transport-safe Codex schema on %s without real QQ", async (
    _providerLabel,
    kind
  ) => {
    const provider = new OpenAIProvider(providerConfig(kind));
    const transport = installRounds(provider, kind, [{ text: "schema fixture accepted" }]);
    const effects = sideEffects();

    await expect(provider.completeTurn(
      "system",
      [{ role: "user", content: "schema fixture" }],
      effects.options
    )).resolves.toEqual({ kind: "completed", text: "schema fixture accepted" });

    const body = transport.requestBody();
    const mapped = mappedCodexTool(body, kind);
    expect(mapped).toBeDefined();
    const parameters = kind === "anthropic-official"
      ? mapped.input_schema
      : kind === "gemini-official"
        ? mapped.parametersJsonSchema
        : mapped.parameters;
    expect(parameters.properties.inputHandles).toBeDefined();
    expect(parameters.properties.inputHandles).not.toHaveProperty("uniqueItems");
    expect(JSON.stringify(body)).not.toContain('"uniqueItems"');
  });

  it("returns the exact Gemini functionCall id in the next functionResponse round", async () => {
    const provider = new OpenAIProvider(providerConfig("gemini-official"));
    const providerCallId = "gemini-native-call-42";
    const transport = installRounds(provider, "gemini-official", [
      {
        calls: [{
          id: providerCallId,
          name: ADD_WORKMEMORY_TOOL_NAME,
          args: { action: "skip", content: null }
        }]
      },
      { text: "两轮完成。" }
    ]);
    const effects = sideEffects();
    let resolved = false;

    await expect(provider.completeTurn(
      "system",
      [{ role: "user", content: "两轮 fixture" }],
      {
        ...effects.options,
        workingMemory: {
          decisionRequired: true,
          decisionResolved: () => resolved,
          execute: vi.fn(async () => {
            resolved = true;
            return { ok: true, action: "skip" };
          })
        }
      }
    )).resolves.toEqual({ kind: "completed", text: "两轮完成。" });

    const secondBody = transport.requestBody(1);
    expect(secondBody.contents.at(-2).parts[0].functionCall.id).toBe(providerCallId);
    expect(secondBody.contents.at(-1).parts[0].functionResponse.id).toBe(providerCallId);
  });

  it.each(PROVIDERS)("executes a file tool alongside sibling assistant text on %s", async (
    _providerLabel,
    kind
  ) => {
    const provider = new OpenAIProvider(providerConfig(kind));
    installRounds(provider, kind, [
      {
        text: "我先读取文件。",
        calls: [{ name: "read_file", args: { path: "safe.txt" } }]
      },
      { text: "读取完成。" }
    ]);
    const effects = sideEffects();

    await expect(provider.completeTurn("system", [{ role: "user", content: "读取文件" }], effects.options))
      .resolves.toEqual({ kind: "completed", text: "读取完成。" });

    expect(effects.onAssistantText).toHaveBeenCalledWith("我先读取文件。", "text");
    expect(effects.read).toHaveBeenCalledOnce();
  });

  it.each(PROVIDERS)("allows local, outbound and multiple MCP servers across model rounds on %s", async (
    _providerLabel,
    kind
  ) => {
    const provider = new OpenAIProvider(providerConfig(kind));
    installRounds(provider, kind, [
      { calls: [{ name: "memory_recall", args: { query: "context" } }] },
      { calls: [{ name: "websearch", args: { query: "current facts", maxResults: 2 } }] },
      { calls: [{ name: "read_file", args: { path: "safe.txt" } }] },
      { calls: [{ name: MCP_FIRST_TOOL_NAME, args: { query: "first" } }] },
      { calls: [{ name: MCP_SECOND_TOOL_NAME, args: { query: "second" } }] },
      { text: "全部调用完成。" }
    ]);
    const effects = sideEffects();

    await expect(provider.completeTurn("system", [{ role: "user", content: "组合调用" }], effects.options))
      .resolves.toEqual({ kind: "completed", text: "全部调用完成。" });

    expect(effects.recall).toHaveBeenCalledOnce();
    expect(runWebsearch).toHaveBeenCalledOnce();
    expect(effects.read).toHaveBeenCalledOnce();
    expect(effects.callMcp).toHaveBeenCalledTimes(2);
  });

  it.each(PROVIDERS)("completes an empty final round after delivered text and a file on %s", async (
    _providerLabel, kind
  ) => {
    const provider = new OpenAIProvider(providerConfig(kind));
    installRounds(provider, kind, [
      { calls: [{ name: "assistant_text", args: { text: "正在处理。" } }] },
      { calls: [{ name: "send_file", args: { path: "result.txt", kind: "file", name: null } }] },
      kind === "gemini-official" ? { text: " " } : {}
    ]);
    const effects = sideEffects();
    await expect(provider.completeTurn("system", [{ role: "user", content: "发送文件" }], effects.options))
      .resolves.toEqual({ kind: "completed", text: "正在处理。", messageOrigin: "assistant_text", textAlreadyDelivered: true });
    expect(effects.send).toHaveBeenCalledOnce();
    expect(effects.options.onAssistantText).toHaveBeenCalledOnce();
  });

  it.each(PROVIDERS)("rejects empty completion after read-only tools with no delivered text on %s", async (
    _providerLabel, kind
  ) => {
    const provider = new OpenAIProvider(providerConfig(kind));
    installRounds(provider, kind, [
      { calls: [{ name: "read_file", args: { path: "safe.txt" } }] },
      kind === "gemini-official" ? { text: " " } : {}
    ]);
    const effects = sideEffects();
    await expect(provider.completeTurn("system", [{ role: "user", content: "读文件" }], effects.options))
      .rejects.toThrow("模型没有返回可发送内容。");
    expect(effects.options.onAssistantText).not.toHaveBeenCalled();
  });

  it.each(PROVIDERS)("keeps an empty system configuration confirmation failed on %s", async (
    _providerLabel, kind
  ) => {
    const provider = new OpenAIProvider(providerConfig(kind));
    installRounds(provider, kind, [
      { calls: [{ name: "assistant_text", args: { text: "正在处理。" } }] },
      kind === "gemini-official" ? { text: " " } : {}
    ]);
    const effects = sideEffects();
    await expect(provider.completeTurn("system", [{ role: "user", content: "改设置" }], {
      ...effects.options,
      systemConfig: { execute: vi.fn(), mutationStaged: () => true }
    })).rejects.toThrow("模型没有返回可发送内容。");
  });

  it.each(PROVIDERS)("does not treat a failed inline delivery as delivered text on %s", async (
    _providerLabel, kind
  ) => {
    const provider = new OpenAIProvider(providerConfig(kind));
    const transport = installRounds(provider, kind, [
      { calls: [{ name: "assistant_text", args: { text: "正在处理。" } }] },
      kind === "gemini-official" ? { text: " " } : {}
    ]);
    const effects = sideEffects();
    effects.options.onAssistantText.mockRejectedValueOnce(new Error("fixture_delivery_failed"));
    await expect(provider.completeTurn("system", [{ role: "user", content: "发送文件" }], effects.options))
      .rejects.toThrow("模型没有返回可发送内容。");
    expect(JSON.stringify(transport.requestBody(1))).toContain("fixture_delivery_failed");
  });

  it("keeps a Codex transport failure after delivered text visible", async () => {
    const provider = new OpenAIProvider(providerConfig("codex-responses"));
    installRounds(provider, "codex-responses", [
      { calls: [{ name: "assistant_text", args: { text: "正在处理。" } }] }
    ]);
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(new Response(JSON.stringify({
      error: { message: "fixture_transport_failed" }
    }), { status: 400 }));
    const effects = sideEffects();
    await expect(provider.completeTurn("system", [{ role: "user", content: "发送文件" }], effects.options))
      .rejects.toThrow("fixture_transport_failed");
    expect(effects.options.onAssistantText).toHaveBeenCalledOnce();
  });

  it.each([
    ["failed", { code: "server_error", message: "fixture_response_failed" }, "fixture_response_failed"],
    ["failed", null, "模型请求失败。"],
    ["incomplete", null, "模型没有返回可发送内容。"]
  ])("rejects an explicit %s Responses payload after delivered text", async (status, error, message) => {
    const provider = new OpenAIProvider(providerConfig("openai-official"));
    const create = vi.fn()
      .mockResolvedValueOnce({ output: responsesOutput({
        calls: [{ name: "assistant_text", args: { text: "正在处理。" } }]
      }, 0) })
      .mockResolvedValueOnce({ status, error, output: [] });
    vi.spyOn(provider as never, "createClient").mockReturnValue({ responses: { create } });
    const effects = sideEffects();

    await expect(provider.completeTurn("system", [{ role: "user", content: "发送文件" }], effects.options))
      .rejects.toThrow(message as string);
    expect(effects.options.onAssistantText).toHaveBeenCalledOnce();
    expect(appendRequestLog).toHaveBeenCalledWith(expect.objectContaining({
      category: "model.response", action: "responses.complete",
      response: expect.objectContaining({ ok: false, error: message })
    }));
  });

  it.each(PROVIDERS)("allows read_file, write_file and send_file across model rounds on %s", async (
    _providerLabel,
    kind
  ) => {
    const provider = new OpenAIProvider(providerConfig(kind));
    installRounds(provider, kind, [
      { calls: [{ name: "read_file", args: { path: "safe.txt" } }] },
      { calls: [{ name: "write_file", args: {
        path: "result.txt",
        content: "done",
        overwrite: false
      } }] },
      { calls: [{ name: "send_file", args: {
        path: "result.txt",
        kind: "file",
        name: null
      } }] },
      { text: "文件已发送。" }
    ]);
    const effects = sideEffects();

    await expect(provider.completeTurn("system", [{ role: "user", content: "读取、写入并发送" }], effects.options))
      .resolves.toEqual({ kind: "completed", text: "文件已发送。" });

    expect(effects.read).toHaveBeenCalledOnce();
    expect(effects.write).toHaveBeenCalledOnce();
    expect(effects.send).toHaveBeenCalledOnce();
  });

  it.each(PROVIDERS)("allows a Skill step before deferred Codex dispatch on %s", async (
    _providerLabel,
    kind
  ) => {
    const provider = new OpenAIProvider(providerConfig(kind));
    installRounds(provider, kind, [
      { calls: [{ name: "activate_skill", args: { skillId: "test-skill" } }] },
      { calls: [{ name: "codex", args: {
        task: "Follow the activated Skill.",
        kind: "analysis",
        dispatch_message: "我开始处理。"
      } }] }
    ]);
    const effects = sideEffects();

    await expect(provider.completeTurn("system", [{ role: "user", content: "使用 Skill 后处理" }], effects.options))
      .resolves.toMatchObject({
        kind: "deferred",
        acknowledgement: "我开始处理。",
        toolCall: { name: "codex" }
      });

    expect(effects.activateSkill).toHaveBeenCalledOnce();
  });

  it.each(PROVIDERS)("allows chat media export before deferred Codex dispatch on %s", async (
    _providerLabel,
    kind
  ) => {
    const provider = new OpenAIProvider(providerConfig(kind));
    installRounds(provider, kind, [
      { calls: [{ name: "export_chat_media", args: { handle: "message:77:image:0" } }] },
      { calls: [{ name: "codex", args: {
        task: "Process chat-media-a.png.",
        kind: "local",
        dispatch_message: "我开始处理素材。"
      } }] }
    ]);
    const effects = sideEffects();

    await expect(provider.completeTurn("system", [{ role: "user", content: "处理图片" }], effects.options))
      .resolves.toMatchObject({
        kind: "deferred",
        acknowledgement: "我开始处理素材。",
        toolCall: { name: "codex" }
      });

    expect(effects.exportMedia).toHaveBeenCalledOnce();
  });

  it.each(PROVIDERS)("executes inline work from the same response before returning deferred dispatch on %s", async (
    _providerLabel,
    kind
  ) => {
    const provider = new OpenAIProvider(providerConfig(kind));
    installRounds(provider, kind, [{
      calls: [
        { name: "export_chat_media", args: { handle: "message:77:image:0" } },
        { name: "codex", args: {
          task: "Process chat-media-a.png.",
          kind: "local",
          dispatch_message: "素材已导出，我开始处理。"
        } }
      ]
    }]);
    const effects = sideEffects();

    await expect(provider.completeTurn("system", [{ role: "user", content: "立即处理图片" }], effects.options))
      .resolves.toMatchObject({
        kind: "deferred",
        acknowledgement: "素材已导出，我开始处理。",
        toolCall: { name: "codex" }
      });

    expect(effects.exportMedia).toHaveBeenCalledOnce();
  });

  it.each(PROVIDERS)("continues to an outbound tool after a failed local call on %s", async (
    _providerLabel,
    kind
  ) => {
    const provider = new OpenAIProvider(providerConfig(kind));
    installRounds(provider, kind, [
      { calls: [{ name: "memory_recall", args: { query: "missing" } }] },
      { calls: [{ name: "websearch", args: { query: "fallback", maxResults: 2 } }] },
      { text: "已改用联网查询。" }
    ]);
    const effects = sideEffects();
    effects.recall.mockResolvedValueOnce({ ok: false, error: "not found" });

    await expect(provider.completeTurn("system", [{ role: "user", content: "查询" }], effects.options))
      .resolves.toEqual({ kind: "completed", text: "已改用联网查询。" });

    expect(effects.recall).toHaveBeenCalledOnce();
    expect(runWebsearch).toHaveBeenCalledOnce();
  });
});

interface ModelCall {
  id?: string;
  name: string;
  args: Record<string, unknown>;
}

interface ModelRound {
  text?: string;
  calls?: ModelCall[];
}

function installRounds(provider: OpenAIProvider, kind: ProviderKind, rounds: ModelRound[]) {
  if (kind === "openai-official") {
    const create = vi.fn();
    for (const [roundIndex, round] of rounds.entries()) {
      create.mockResolvedValueOnce({ output: responsesOutput(round, roundIndex) });
    }
    vi.spyOn(provider as never, "createClient").mockReturnValue({ responses: { create } });
    return {
      requestBody: (index = 0) => create.mock.calls[index]?.[0] as Record<string, any>
    };
  }
  if (kind === "openai-compatible") {
    const create = vi.fn();
    for (const [roundIndex, round] of rounds.entries()) {
      create.mockResolvedValueOnce(chatResponse(round, roundIndex));
    }
    vi.spyOn(provider as never, "createChatClient").mockReturnValue({ chat: { completions: { create } } });
    return {
      requestBody: (index = 0) => create.mock.calls[index]?.[0] as Record<string, any>
    };
  }
  if (kind === "codex-responses") {
    vi.spyOn(provider as never, "getApiKeyAsync").mockResolvedValue(`${kind}-key`);
  } else {
    vi.spyOn(provider as never, "getApiKey").mockReturnValue(`${kind}-key`);
  }
  const fetchMock = vi.spyOn(globalThis, "fetch");
  for (const [roundIndex, round] of rounds.entries()) {
    if (kind === "codex-responses") {
      fetchMock.mockResolvedValueOnce(codexResponse(responsesOutput(round, roundIndex)));
    } else if (kind === "anthropic-official") {
      fetchMock.mockResolvedValueOnce(jsonResponse(anthropicResponse(round, roundIndex)));
    } else {
      fetchMock.mockResolvedValueOnce(jsonResponse(geminiResponse(round, roundIndex)));
    }
  }
  return {
    requestBody: (index = 0) => JSON.parse(
      String(fetchMock.mock.calls[index]?.[1]?.body)
    ) as Record<string, any>
  };
}

function mappedCodexTool(body: Record<string, any>, kind: ProviderKind) {
  if (kind === "openai-compatible") {
    return body.tools
      .find((tool: Record<string, any>) => tool.function.name === "codex")
      ?.function;
  }
  if (kind === "anthropic-official") {
    return body.tools.find((tool: Record<string, any>) => tool.name === "codex");
  }
  if (kind === "gemini-official") {
    return body.tools[0].functionDeclarations
      .find((tool: Record<string, any>) => tool.name === "codex");
  }
  return body.tools.find((tool: Record<string, any>) => tool.name === "codex");
}

function expectNoForcedToolChoice(body: Record<string, any>) {
  expect(body.tool_choice).toBeUndefined();
  expect(body.toolConfig).toBeUndefined();
}

function responsesOutput(round: ModelRound, roundIndex: number) {
  return [
    ...(round.text ? [responseMessage(round.text)] : []),
    ...(round.calls ?? []).map((call, callIndex) => responseFunctionCall(
      callId(roundIndex, callIndex, call.name),
      call.name,
      call.args
    ))
  ];
}

function chatResponse(round: ModelRound, roundIndex: number) {
  const calls = round.calls ?? [];
  return {
    choices: [{
      finish_reason: calls.length ? "tool_calls" : "stop",
      message: {
        role: "assistant",
        content: round.text ?? null,
        tool_calls: calls.length ? calls.map((call, callIndex) => ({
          id: callId(roundIndex, callIndex, call.name),
          type: "function",
          function: { name: call.name, arguments: JSON.stringify(call.args) }
        })) : undefined
      }
    }]
  };
}

function anthropicResponse(round: ModelRound, roundIndex: number) {
  return {
    content: [
      ...(round.text ? [{ type: "text", text: round.text }] : []),
      ...(round.calls ?? []).map((call, callIndex) => ({
        type: "tool_use",
        id: callId(roundIndex, callIndex, call.name),
        name: call.name,
        input: call.args
      }))
    ],
    stop_reason: round.calls?.length ? "tool_use" : "end_turn"
  };
}

function geminiResponse(round: ModelRound, roundIndex: number) {
  return {
    candidates: [{
      content: {
        role: "model",
        parts: [
          ...(round.text ? [{ text: round.text }] : []),
          ...(round.calls ?? []).map((call, callIndex) => ({
            functionCall: {
              id: call.id ?? callId(roundIndex, callIndex, call.name),
              name: call.name,
              args: call.args
            }
          }))
        ]
      }
    }]
  };
}

function responseMessage(text: string) {
  return {
    type: "message",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text }]
  };
}

function responseFunctionCall(callIdValue: string, name: string, args: Record<string, unknown>) {
  return {
    type: "function_call",
    name,
    call_id: callIdValue,
    arguments: JSON.stringify(args),
    status: "completed"
  };
}

function codexResponse(output: Array<Record<string, unknown>>) {
  const events = output.map((item, outputIndex) => ({
    type: "response.output_item.done",
    output_index: outputIndex,
    item
  }));
  events.push({ type: "response.completed", response: { status: "completed", output } } as never);
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
    status: 200,
    headers: { "content-type": "text/event-stream" }
  });
}

function jsonResponse(payload: unknown) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

function callId(roundIndex: number, callIndex: number, name: string) {
  return `call-${roundIndex}-${callIndex}-${name}`;
}

function sideEffects() {
  let staged = false;
  const read = vi.fn(async () => ({ ok: true, path: "safe.txt", byteLength: 1, content: "x" }));
  const write = vi.fn(async () => ({
    ok: true,
    path: "result.txt",
    byteLength: 4,
    created: true,
    overwritten: false
  }));
  const send = vi.fn(async () => ({ ok: true, queued: true }));
  const recall = vi.fn(async () => ({ ok: true, items: [] }));
  const activateSkill = vi.fn(async () => ({ ok: true, skillId: "test-skill" }));
  const callMcp = vi.fn(async () => ({ ok: true }));
  const exportMedia = vi.fn(async () => ({
    ok: true,
    path: "chat-media-a.png",
    sha256: "a".repeat(64),
    mimeType: "image/png",
    extension: "png",
    byteLength: 10,
    width: 1,
    height: 1,
    deduplicated: false
  }));
  const onAssistantText = vi.fn(async () => undefined);
  const options = {
    allowNoReply: true,
    asyncCodex: true,
    bot: {
      tools: {
        maxCalls: 20,
        websearch: {
          provider: "tavily",
          tavilyApiKey: "test-key",
          tavilyApiKeys: [],
          tavilyApiKeyEnv: "TAVILY_API_KEY",
          maxResults: 5
        }
      }
    } as never,
    onAssistantText,
    workbenchFiles: {
      read,
      write
    },
    conversationAssets: { enabled: true, send },
    memory: { enabled: true, recall },
    skills: {
      skillIds: ["test-skill"],
      activate: activateSkill,
      readResource: vi.fn(async () => ({ ok: true })),
      runScript: vi.fn(async () => ({ ok: true }))
    },
    chatMedia: { export: exportMedia },
    mcp: {
      definitions: () => [MCP_FIRST_TOOL_NAME, MCP_SECOND_TOOL_NAME].map((name) => ({
        type: "function",
        name,
        description: "External tool",
        parameters: {
          type: "object",
          additionalProperties: true,
          properties: {}
        },
        strict: false
      })),
      describe: (name) => ({
        serverId: name === MCP_FIRST_TOOL_NAME ? "server-a" : "server-b",
        transport: "streamable_http" as const
      }),
      call: callMcp
    },
    systemConfig: {
      execute: vi.fn(async () => {
        staged = true;
        return { ok: true, staged: true };
      }),
      mutationStaged: () => staged
    }
  } satisfies ProviderCompleteOptions;
  return {
    options,
    read,
    write,
    send,
    recall,
    activateSkill,
    callMcp,
    exportMedia,
    onAssistantText
  };
}

function providerConfig(kind: ProviderKind): ProviderConfig {
  const model = kind.startsWith("anthropic")
    ? "claude-sonnet-4-6"
    : kind.startsWith("gemini")
      ? "gemini-2.5-flash"
      : "gpt-5.4-mini";
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
