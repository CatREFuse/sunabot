// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderCompleteOptions } from "../../adapters/model/openaiProvider.js";
import type { ProviderConfig, ProviderKind } from "../../src/types.js";

const appendRequestLog = vi.hoisted(() => vi.fn(async () => undefined));
const runWorkspaceBash = vi.hoisted(() => vi.fn(async () => ({ ok: true })));
const runWebsearch = vi.hoisted(() => vi.fn(async () => ({ ok: true, items: [] })));

vi.mock("../../adapters/observability/requestLog.js", () => ({ appendRequestLog }));
vi.mock("../../services/tools/bashTool.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../services/tools/bashTool.js")>(),
  runWorkspaceBash
}));
vi.mock("../../adapters/model/webSearchTool.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../adapters/model/webSearchTool.js")>(),
  runWebsearch
}));

import { OpenAIProvider } from "../../adapters/model/openaiProvider.js";
import { RegistryProviderToolExecutor } from "../../adapters/model/provider/toolExecutor.js";

const MCP_TOOL_NAME = `mcp_${"a".repeat(48)}`;
const MCP_STDIO_TOOL_NAME = `mcp_${"b".repeat(48)}`;
const MCP_SECOND_SERVER_TOOL_NAME = `mcp_${"c".repeat(48)}`;

const PROVIDERS = [
  ["OpenAI Responses", "openai-official"],
  ["Codex Responses", "codex-responses"],
  ["Chat Completions", "openai-compatible"],
  ["Anthropic Messages", "anthropic-official"],
  ["Gemini generateContent", "gemini-official"]
] as const;

const RESTRICTED_TOOLS = [
  ["system_config", systemConfigMutationInput()],
  ["send_file", { path: "exports/report.txt", kind: "file", name: null }],
  ["read_file", { path: "safe.txt" }],
  ["write_file", { path: "safe.txt", content: "sensitive text", overwrite: false }],
  ["native_bash", { command: "ls", timeoutMs: null }],
  ["docker_bash", { command: "ls", timeoutMs: null }],
  ["activate_skill", { skillId: "test-skill" }],
  ["read_skill_resource", { skillId: "test-skill", path: "references/guide.md" }],
  ["run_skill_script", { skillId: "test-skill", path: "scripts/run.sh", args: [] }],
  [MCP_TOOL_NAME, { query: "sensitive" }]
] as const;

afterEach(() => {
  vi.restoreAllMocks();
  appendRequestLog.mockClear();
  runWorkspaceBash.mockClear();
  runWebsearch.mockClear();
});

describe("restricted tool response preflight", () => {
  it.each(PROVIDERS.flatMap(([providerLabel, kind]) => RESTRICTED_TOOLS.map(([toolName, args]) => ({
    providerLabel,
    kind,
    toolName,
    args
  }))))("rejects $toolName sibling text on $providerLabel before every side effect", async ({
    kind,
    toolName,
    args
  }) => {
    const provider = new OpenAIProvider(providerConfig(kind));
    installRounds(provider, kind, [
      { text: "这段正文不应发送", calls: [{ name: toolName, args }] },
      { text: "冲突调用已拒绝" }
    ]);
    const effects = sideEffects();

    await expect(provider.completeTurn("system", [{ role: "user", content: "执行受限操作" }], effects.options))
      .resolves.toEqual({ kind: "completed", text: "冲突调用已拒绝" });

    expect(effects.onAssistantText).not.toHaveBeenCalled();
    expect(effects.onToolCall).not.toHaveBeenCalled();
    expect(effects.read).not.toHaveBeenCalled();
    expect(effects.write).not.toHaveBeenCalled();
    expect(effects.send).not.toHaveBeenCalled();
    expect(effects.recall).not.toHaveBeenCalled();
    expect(effects.activateSkill).not.toHaveBeenCalled();
    expect(effects.readSkillResource).not.toHaveBeenCalled();
    expect(effects.runSkillScript).not.toHaveBeenCalled();
    expect(effects.callMcp).not.toHaveBeenCalled();
    expect(runWorkspaceBash).not.toHaveBeenCalled();
    expect(effects.systemConfig.execute).not.toHaveBeenCalled();
    expect(effects.systemConfig.rejectTurn).toHaveBeenCalledTimes(toolName === "system_config" ? 1 : 0);
  });

  it.each(PROVIDERS)("rejects a restricted + deferred batch on %s before queue or Bash", async (
    _providerLabel,
    kind
  ) => {
    const provider = new OpenAIProvider(providerConfig(kind));
    installRounds(provider, kind, [
      {
        calls: [
          { name: "docker_bash", args: { command: "ls", timeoutMs: null } },
          { name: "codex", args: { prompt: "inspect", dispatch_message: "正在检查" } }
        ]
      },
      { text: "混合调用已拒绝" }
    ]);
    const effects = sideEffects();

    await expect(provider.completeTurn("system", [{ role: "user", content: "检查" }], effects.options))
      .resolves.toEqual({ kind: "completed", text: "混合调用已拒绝" });

    assertNoSideEffects(effects);
  });

  it.each(PROVIDERS)("blocks local data followed by MCP across model rounds on %s", async (
    _providerLabel,
    kind
  ) => {
    const provider = new OpenAIProvider(providerConfig(kind));
    installRounds(provider, kind, [
      { calls: [{ name: "read_file", args: { path: "safe.txt" } }] },
      { calls: [{ name: MCP_TOOL_NAME, args: { payload: "local-data" } }] },
      { text: "跨边界调用已拒绝" }
    ]);
    const effects = sideEffects();
    await expect(provider.completeTurn("system", [{ role: "user", content: "读取后外发" }], effects.options))
      .resolves.toEqual({ kind: "completed", text: "跨边界调用已拒绝" });
    expect(effects.read).toHaveBeenCalledOnce();
    expect(effects.callMcp).not.toHaveBeenCalled();
  });

  it.each(PROVIDERS)("blocks MCP followed by local execution across model rounds on %s", async (
    _providerLabel,
    kind
  ) => {
    const provider = new OpenAIProvider(providerConfig(kind));
    installRounds(provider, kind, [
      { calls: [{ name: MCP_TOOL_NAME, args: { query: "external" } }] },
      { calls: [{ name: "run_skill_script", args: {
        skillId: "test-skill", path: "scripts/run.sh", args: []
      } }] },
      { text: "跨边界调用已拒绝" }
    ]);
    const effects = sideEffects();
    await expect(provider.completeTurn("system", [{ role: "user", content: "外部调用后执行" }], effects.options))
      .resolves.toEqual({ kind: "completed", text: "跨边界调用已拒绝" });
    expect(effects.callMcp).toHaveBeenCalledOnce();
    expect(effects.runSkillScript).not.toHaveBeenCalled();
  });

  it.each(PROVIDERS)("treats stdio MCP as local data and blocks a later outbound tool on %s", async (
    _providerLabel,
    kind
  ) => {
    const provider = new OpenAIProvider(providerConfig(kind));
    installRounds(provider, kind, [
      { calls: [{ name: MCP_STDIO_TOOL_NAME, args: { query: "workbench" } }] },
      { calls: [{ name: "websearch", args: { query: "external", maxResults: 2 } }] },
      { text: "跨边界调用已拒绝" }
    ]);
    const effects = sideEffects();
    await expect(provider.completeTurn("system", [{ role: "user", content: "本地读取后联网" }], effects.options))
      .resolves.toEqual({ kind: "completed", text: "跨边界调用已拒绝" });
    expect(effects.callMcp).toHaveBeenCalledOnce();
    expect(runWebsearch).not.toHaveBeenCalled();
  });

  it.each(PROVIDERS)("treats stdio MCP as local data and blocks it after outbound activity on %s", async (
    _providerLabel,
    kind
  ) => {
    const provider = new OpenAIProvider(providerConfig(kind));
    installRounds(provider, kind, [
      { calls: [{ name: "websearch", args: { query: "external", maxResults: 2 } }] },
      { calls: [{ name: MCP_STDIO_TOOL_NAME, args: { query: "workbench" } }] },
      { text: "跨边界调用已拒绝" }
    ]);
    const effects = sideEffects();
    await expect(provider.completeTurn("system", [{ role: "user", content: "联网后读取本地" }], effects.options))
      .resolves.toEqual({ kind: "completed", text: "跨边界调用已拒绝" });
    expect(runWebsearch).toHaveBeenCalledOnce();
    expect(effects.callMcp).not.toHaveBeenCalled();
  });

  it.each(PROVIDERS)("allows local data and stdio MCP from the same server class on %s", async (
    _providerLabel,
    kind
  ) => {
    const provider = new OpenAIProvider(providerConfig(kind));
    installRounds(provider, kind, [
      { calls: [{ name: "read_file", args: { path: "safe.txt" } }] },
      { calls: [{ name: MCP_STDIO_TOOL_NAME, args: { query: "workbench" } }] },
      { text: "本地调用完成" }
    ]);
    const effects = sideEffects();
    await expect(provider.completeTurn("system", [{ role: "user", content: "读取本地" }], effects.options))
      .resolves.toEqual({ kind: "completed", text: "本地调用完成" });
    expect(effects.read).toHaveBeenCalledOnce();
    expect(effects.callMcp).toHaveBeenCalledOnce();
  });

  it.each(PROVIDERS)("allows only one MCP server in one provider turn on %s", async (
    _providerLabel,
    kind
  ) => {
    const provider = new OpenAIProvider(providerConfig(kind));
    installRounds(provider, kind, [
      { calls: [{ name: MCP_TOOL_NAME, args: { query: "server-a" } }] },
      { calls: [{ name: MCP_SECOND_SERVER_TOOL_NAME, args: { query: "server-b" } }] },
      { text: "跨服务调用已拒绝" }
    ]);
    const effects = sideEffects();
    await expect(provider.completeTurn("system", [{ role: "user", content: "调用两个服务" }], effects.options))
      .resolves.toEqual({ kind: "completed", text: "跨服务调用已拒绝" });
    expect(effects.callMcp).toHaveBeenCalledOnce();
  });

  it.each(PROVIDERS)("blocks read_file followed by websearch across model rounds on %s", async (
    _providerLabel,
    kind
  ) => {
    const provider = new OpenAIProvider(providerConfig(kind));
    installRounds(provider, kind, [
      { calls: [{ name: "read_file", args: { path: "safe.txt" } }] },
      { calls: [{ name: "websearch", args: { query: "local-data", maxResults: 2 } }] },
      { text: "跨边界调用已拒绝" }
    ]);
    const effects = sideEffects();
    await expect(provider.completeTurn("system", [{ role: "user", content: "读取后搜索" }], effects.options))
      .resolves.toEqual({ kind: "completed", text: "跨边界调用已拒绝" });
    expect(effects.read).toHaveBeenCalledOnce();
    expect(runWebsearch).not.toHaveBeenCalled();
  });

  it.each(PROVIDERS)("blocks memory recall followed by websearch across model rounds on %s", async (
    _providerLabel,
    kind
  ) => {
    const provider = new OpenAIProvider(providerConfig(kind));
    installRounds(provider, kind, [
      { calls: [{ name: "memory_recall", args: { query: "secret" } }] },
      { calls: [{ name: "websearch", args: { query: "memory-data", maxResults: 2 } }] },
      { text: "跨边界调用已拒绝" }
    ]);
    const effects = sideEffects();
    await expect(provider.completeTurn("system", [{ role: "user", content: "回忆后搜索" }], effects.options))
      .resolves.toEqual({ kind: "completed", text: "跨边界调用已拒绝" });
    expect(effects.recall).toHaveBeenCalledOnce();
    expect(runWebsearch).not.toHaveBeenCalled();
  });

  it.each(PROVIDERS)("blocks websearch followed by read_file across model rounds on %s", async (
    _providerLabel,
    kind
  ) => {
    const provider = new OpenAIProvider(providerConfig(kind));
    installRounds(provider, kind, [
      { calls: [{ name: "websearch", args: { query: "external", maxResults: 2 } }] },
      { calls: [{ name: "read_file", args: { path: "safe.txt" } }] },
      { text: "跨边界调用已拒绝" }
    ]);
    const effects = sideEffects();
    await expect(provider.completeTurn("system", [{ role: "user", content: "搜索后读取" }], effects.options))
      .resolves.toEqual({ kind: "completed", text: "跨边界调用已拒绝" });
    expect(runWebsearch).toHaveBeenCalledOnce();
    expect(effects.read).not.toHaveBeenCalled();
  });

  it.each(PROVIDERS)("clears local-data taint for the next user turn on %s", async (
    _providerLabel,
    kind
  ) => {
    const provider = new OpenAIProvider(providerConfig(kind));
    installRounds(provider, kind, [
      { calls: [{ name: "read_file", args: { path: "safe.txt" } }] },
      { text: "第一轮完成" },
      { calls: [{ name: "websearch", args: { query: "fresh-turn", maxResults: 2 } }] },
      { text: "第二轮完成" }
    ]);
    const effects = sideEffects();
    await expect(provider.completeTurn("system", [{ role: "user", content: "读取" }], effects.options))
      .resolves.toEqual({ kind: "completed", text: "第一轮完成" });
    await expect(provider.completeTurn("system", [{ role: "user", content: "新一轮搜索" }], effects.options))
      .resolves.toEqual({ kind: "completed", text: "第二轮完成" });
    expect(effects.read).toHaveBeenCalledOnce();
    expect(runWebsearch).toHaveBeenCalledOnce();
  });

  it.each([
    ["assistant_text", { text: "处理中" }],
    ["no_reply", {}],
    ["memory_recall", { query: "secret" }]
  ] as const)("rejects docker_bash mixed with %s before inline or terminal effects", async (name, args) => {
    const provider = new OpenAIProvider(providerConfig("openai-official"));
    installRounds(provider, "openai-official", [
      {
        calls: [
          { name: "docker_bash", args: { command: "ls", timeoutMs: null } },
          { name, args }
        ]
      },
      { text: "混合调用已拒绝" }
    ]);
    const effects = sideEffects();

    await expect(provider.completeTurn("system", [{ role: "user", content: "检查" }], effects.options))
      .resolves.toEqual({ kind: "completed", text: "混合调用已拒绝" });

    assertNoSideEffects(effects);
  });

  it("keeps the restricted batch gate in the direct executor path", async () => {
    const executor = new RegistryProviderToolExecutor();
    const effects = sideEffects();
    const calls = [
      directCall("call-bash", "docker_bash", { command: "ls", timeoutMs: null }),
      directCall("call-memory", "memory_recall", { query: "secret" })
    ];
    const outputs = await executor.execute(
      calls,
      effects.options,
      executor.resolveDefinitions(effects.options, [])
    );

    expect(outputs.map((output) => JSON.parse(String(output.output)))).toEqual([
      { ok: false, error: "docker_bash must be called alone before any other tool." },
      { ok: false, error: "docker_bash must be called alone before any other tool." }
    ]);
    assertNoSideEffects(effects);
  });

  it.each(PROVIDERS)("discards a staged system_config mutation before later raw text on %s", async (
    _providerLabel,
    kind
  ) => {
    const provider = new OpenAIProvider(providerConfig(kind));
    installRounds(provider, kind, [
      { calls: [{ name: "system_config", args: systemConfigMutationInput() }] },
      {
        text: "这段正文不应发送",
        calls: [{ name: "assistant_text", args: { text: "这条行动消息也不应发送" } }]
      },
      { text: "已撤销未确认修改" }
    ]);
    const effects = sideEffects();

    await expect(provider.completeTurn("system", [{ role: "user", content: "关闭自动回复" }], effects.options))
      .resolves.toEqual({ kind: "completed", text: "已撤销未确认修改" });

    expect(effects.systemConfig.execute).toHaveBeenCalledOnce();
    expect(effects.systemConfig.rejectTurn).toHaveBeenCalledOnce();
    expect(effects.systemConfig.mutationStaged()).toBe(false);
    expect(effects.onAssistantText).not.toHaveBeenCalled();
    expect(effects.onToolCall).toHaveBeenCalledTimes(1);
    expect(effects.onToolCall).toHaveBeenCalledWith("system_config");
    expect(effects.read).not.toHaveBeenCalled();
    expect(effects.write).not.toHaveBeenCalled();
    expect(effects.send).not.toHaveBeenCalled();
    expect(effects.recall).not.toHaveBeenCalled();
    expect(runWorkspaceBash).not.toHaveBeenCalled();
  });

  it.each(PROVIDERS)("keeps ordinary memory_recall + sibling text behavior on %s", async (
    _providerLabel,
    kind
  ) => {
    const provider = new OpenAIProvider(providerConfig(kind));
    installRounds(provider, kind, [
      {
        text: "先补充一条进度",
        calls: [{ name: "memory_recall", args: { query: "roadmap" } }]
      },
      { text: "普通工具处理完成" }
    ]);
    const effects = sideEffects();

    await expect(provider.completeTurn("system", [{ role: "user", content: "回顾计划" }], effects.options))
      .resolves.toEqual({ kind: "completed", text: "普通工具处理完成" });

    expect(effects.onAssistantText).toHaveBeenCalledOnce();
    expect(effects.onAssistantText).toHaveBeenCalledWith("先补充一条进度", "text");
    expect(effects.onToolCall).toHaveBeenCalledOnce();
    expect(effects.onToolCall).toHaveBeenCalledWith("memory_recall");
    expect(effects.recall).toHaveBeenCalledOnce();
  });

  it.each(PROVIDERS)("allows add_workmemory with sibling text and outbound tools on %s", async (
    _providerLabel,
    kind
  ) => {
    const provider = new OpenAIProvider(providerConfig(kind));
    installRounds(provider, kind, [
      {
        text: "我先记录这项临时约定。",
        calls: [
          { name: "websearch", args: { query: "external", maxResults: 2 } },
          { name: "add_workmemory", args: {
            content: "老师（QQ 171419991）希望我后续继续核对外部资料。"
          } }
        ]
      },
      { text: "记录和查询都已完成" }
    ]);
    const effects = sideEffects();

    await expect(provider.completeTurn("system", [{ role: "user", content: "查询后记住" }], effects.options))
      .resolves.toEqual({ kind: "completed", text: "记录和查询都已完成" });

    expect(effects.onAssistantText).toHaveBeenCalledWith("我先记录这项临时约定。", "text");
    expect(runWebsearch).toHaveBeenCalledOnce();
    expect(effects.addWorkMemory).toHaveBeenCalledOnce();
    expect(effects.addWorkMemory).toHaveBeenCalledWith({
      content: "老师（QQ 171419991）希望我后续继续核对外部资料。"
    }, undefined);
  });
});

interface ModelCall {
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
    return;
  }
  if (kind === "openai-compatible") {
    const create = vi.fn();
    for (const [roundIndex, round] of rounds.entries()) {
      create.mockResolvedValueOnce(chatResponse(round, roundIndex));
    }
    vi.spyOn(provider as never, "createChatClient").mockReturnValue({ chat: { completions: { create } } });
    return;
  }
  vi.spyOn(provider as never, "getApiKey").mockReturnValue(`${kind}-key`);
  const fetchMock = vi.spyOn(globalThis, "fetch");
  for (const [roundIndex, round] of rounds.entries()) {
    if (kind === "codex-responses") {
      fetchMock.mockResolvedValueOnce(codexResponse(responsesOutput(round, roundIndex)));
    } else if (kind === "anthropic-official") {
      fetchMock.mockResolvedValueOnce(jsonResponse(anthropicResponse(round, roundIndex)));
    } else {
      fetchMock.mockResolvedValueOnce(jsonResponse(geminiResponse(round)));
    }
  }
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

function geminiResponse(round: ModelRound) {
  return {
    candidates: [{
      content: {
        role: "model",
        parts: [
          ...(round.text ? [{ text: round.text }] : []),
          ...(round.calls ?? []).map((call) => ({ functionCall: { name: call.name, args: call.args } }))
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

function directCall(callIdValue: string, name: string, args: Record<string, unknown>) {
  return {
    type: "function_call" as const,
    name,
    call_id: callIdValue,
    arguments: JSON.stringify(args)
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
  let rejected = false;
  const read = vi.fn(async () => ({ ok: true, path: "safe.txt", byteLength: 1, content: "x" }));
  const write = vi.fn(async () => ({
    ok: true,
    path: "safe.txt",
    byteLength: 14,
    created: true,
    overwritten: false
  }));
  const send = vi.fn(async () => ({ ok: true, queued: true }));
  const recall = vi.fn(async () => ({ ok: true, items: [] }));
  const addWorkMemory = vi.fn(async () => ({ ok: true }));
  const activateSkill = vi.fn(async () => ({ ok: true, skillId: "test-skill" }));
  const readSkillResource = vi.fn(async () => ({ ok: true }));
  const runSkillScript = vi.fn(async () => ({ ok: true }));
  const callMcp = vi.fn(async () => ({ ok: true }));
  const onAssistantText = vi.fn(async () => undefined);
  const onToolCall = vi.fn();
  const systemConfig = {
    execute: vi.fn(async () => {
      staged = true;
      return { ok: true, staged: true };
    }),
    mutationStaged: () => staged,
    rejectTurn: vi.fn(() => {
      staged = false;
      rejected = true;
    }),
    turnRejected: () => rejected
  } satisfies NonNullable<ProviderCompleteOptions["systemConfig"]>;
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
    onToolCall,
    workbenchFiles: { read, write },
    conversationAssets: { enabled: true, send },
    bash: {
      native: bashHandle("native", "admin"),
      docker: bashHandle("docker", "isolated")
    },
    memory: { enabled: true, recall },
    workingMemory: { execute: addWorkMemory },
    skills: {
      skillIds: ["test-skill"],
      activate: activateSkill,
      readResource: readSkillResource,
      runScript: runSkillScript
    },
    mcp: {
      definitions: () => [MCP_TOOL_NAME, MCP_STDIO_TOOL_NAME, MCP_SECOND_SERVER_TOOL_NAME].map((name) => ({
        type: "function",
        name,
        description: "External search",
        parameters: { type: "object", additionalProperties: false, properties: {} },
        strict: true
      })),
      describe: (name) => name === MCP_STDIO_TOOL_NAME
        ? { serverId: "stdio-server", transport: "stdio" }
        : name === MCP_SECOND_SERVER_TOOL_NAME
          ? { serverId: "http-server-b", transport: "streamable_http" }
          : { serverId: "http-server-a", transport: "streamable_http" },
      call: callMcp
    },
    systemConfig
  } satisfies ProviderCompleteOptions;
  return {
    options, read, write, send, recall, addWorkMemory, activateSkill, readSkillResource, runSkillScript,
    callMcp, onAssistantText, onToolCall, systemConfig
  };
}

function bashHandle(backend: "native" | "docker", accessMode: "admin" | "isolated") {
  return {
    enabled: true as const,
    workspacePath: "/must-not-be-read",
    backend,
    accessMode,
    strictMode: true,
    isCurrent: () => true,
    audit: vi.fn(async () => ({
      decision: "allow" as const,
      risk: "low" as const,
      outsideWorkbench: false,
      outsideAccesses: [],
      violations: [],
      summary: "safe"
    })),
    approvalContext: {
      backend,
      agentId: "plana",
      accountId: "primary",
      transport: "onebot",
      conversationId: "private:171419991",
      userId: "171419991"
    }
  };
}

function assertNoSideEffects(effects: ReturnType<typeof sideEffects>) {
  expect(effects.onAssistantText).not.toHaveBeenCalled();
  expect(effects.onToolCall).not.toHaveBeenCalled();
  expect(effects.read).not.toHaveBeenCalled();
  expect(effects.write).not.toHaveBeenCalled();
  expect(effects.send).not.toHaveBeenCalled();
  expect(effects.recall).not.toHaveBeenCalled();
  expect(effects.addWorkMemory).not.toHaveBeenCalled();
  expect(effects.activateSkill).not.toHaveBeenCalled();
  expect(effects.callMcp).not.toHaveBeenCalled();
  expect(effects.systemConfig.execute).not.toHaveBeenCalled();
  expect(effects.systemConfig.rejectTurn).not.toHaveBeenCalled();
  expect(runWorkspaceBash).not.toHaveBeenCalled();
}

function systemConfigMutationInput() {
  return {
    operation: "set_auto_reply",
    replyScope: "private",
    enabled: false,
    orchestratorEnabled: null,
    searchImplementation: null,
    bashAdminBackend: null,
    conversationId: null,
    groupCursor: null,
    groupLimit: null
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
