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
  it.each(PROVIDERS)("requires working memory before user profile on %s", async (
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
      }
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
    )).resolves.toEqual({ kind: "completed", text: "这轮已经处理好了。" });

    expectWorkingMemoryToolChoice(transport.requestBody(0), kind);
    expectMemoryToolChoice(transport.requestBody(1), kind, ADD_USER_PROFILE_TOOL_NAME);
  });

  it.each(PROVIDERS)("requires the main reply model to record or skip working memory on %s", async (
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
    }]);
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
    )).resolves.toEqual({ kind: "completed", text: "这轮已经处理好了。" });

    expect(execute).toHaveBeenCalledWith({ action: "skip" }, undefined);
    expectWorkingMemoryToolChoice(transport.requestBody(), kind);
    expect(effects.onAssistantText).not.toHaveBeenCalled();
  });

  it.each(PROVIDERS)("rejects a visible reply that omits the required working-memory decision on %s", async (
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
    )).rejects.toMatchObject({
      code: "WORKING_MEMORY_DECISION_REQUIRED"
    });
    expect(effects.onAssistantText).not.toHaveBeenCalled();
  });

  it.each(PROVIDERS)("rejects terminal no_reply before the required working-memory decision on %s", async (
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
    )).rejects.toMatchObject({
      code: "WORKING_MEMORY_DECISION_REQUIRED"
    });
    expect(effects.onAssistantText).not.toHaveBeenCalled();
  });

  it.each([
    "companion",
    "deferred",
    "no_reply"
  ] as const)("asserts the decision before returning a %s terminal branch", async (branch) => {
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
    })).rejects.toMatchObject({
      code: "WORKING_MEMORY_DECISION_REQUIRED"
    });
  });

  it.each(PROVIDERS)("keeps the mandatory memory decision outside maxCalls=1 on %s", async (
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

function expectWorkingMemoryToolChoice(body: Record<string, any>, kind: ProviderKind) {
  expectMemoryToolChoice(body, kind, ADD_WORKMEMORY_TOOL_NAME);
}

function expectMemoryToolChoice(
  body: Record<string, any>,
  kind: ProviderKind,
  toolName: string
) {
  if (kind === "openai-compatible") {
    expect(body.tool_choice).toEqual({
      type: "function",
      function: { name: toolName }
    });
    return;
  }
  if (kind === "anthropic-official") {
    expect(body.tool_choice).toEqual({
      type: "tool",
      name: toolName,
      disable_parallel_tool_use: true
    });
    return;
  }
  if (kind === "gemini-official") {
    expect(body.toolConfig).toEqual({
      functionCallingConfig: {
        mode: "ANY",
        allowedFunctionNames: [toolName]
      }
    });
    return;
  }
  expect(body.tool_choice).toEqual({
    type: "function",
    name: toolName
  });
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
