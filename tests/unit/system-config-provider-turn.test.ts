// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderCompleteOptions } from "../../adapters/model/openaiProvider.js";
import { OpenAIProvider } from "../../adapters/model/openaiProvider.js";
import type { ProviderConfig, ProviderKind } from "../../src/types.js";

const appendRequestLog = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("../../src/requestLog.js", () => ({ appendRequestLog }));

afterEach(() => {
  vi.restoreAllMocks();
});

describe("system_config provider turn isolation", () => {
  it.each([
    ["OpenAI Responses", "openai-official"],
    ["Chat Completions", "openai-compatible"],
    ["Codex Responses", "codex-responses"],
    ["Anthropic", "anthropic-official"],
    ["Gemini", "gemini-official"]
  ] as const)("rejects sibling text before executing system_config on %s", async (_label, kind) => {
    const provider = new OpenAIProvider(providerConfig(kind));
    const port = systemConfigPort();
    const onAssistantText = vi.fn();
    const onToolCall = vi.fn();
    installSiblingTextResponses(provider, kind);

    await expect(provider.completeTurn("system", [{ role: "user", content: "修改设置" }], {
      systemConfig: port,
      onAssistantText,
      onToolCall
    })).resolves.toEqual({ kind: "completed", text: "当前回合已拒绝。" });

    expect(port.execute).not.toHaveBeenCalled();
    expect(port.rejectTurn).toHaveBeenCalled();
    expect(port.turnRejected()).toBe(true);
    expect(onAssistantText).not.toHaveBeenCalled();
    expect(onToolCall).not.toHaveBeenCalled();
  });

  it("discards a staged mutation before any later assistant_text side effect", async () => {
    const provider = new OpenAIProvider(providerConfig("openai-official"));
    const create = vi.fn()
      .mockResolvedValueOnce({ output: [responseFunctionCall("call-config", "system_config", mutationInput())] })
      .mockResolvedValueOnce({ output: [
        responseMessage("这段正文不应发送"),
        responseFunctionCall("call-progress", "assistant_text", { text: "也不应发送" })
      ] })
      .mockResolvedValueOnce({ output: [responseMessage("当前回合已拒绝。")] });
    vi.spyOn(provider as never, "createClient").mockReturnValue({ responses: { create } });
    const port = systemConfigPort();
    const onAssistantText = vi.fn();
    const onToolCall = vi.fn();

    await expect(provider.completeTurn("system", [{ role: "user", content: "修改设置" }], {
      systemConfig: port,
      onAssistantText,
      onToolCall
    })).resolves.toEqual({ kind: "completed", text: "当前回合已拒绝。" });

    expect(port.execute).toHaveBeenCalledOnce();
    expect(port.rejectTurn).toHaveBeenCalledOnce();
    expect(port.mutationStaged()).toBe(false);
    expect(port.turnRejected()).toBe(true);
    expect(onAssistantText).not.toHaveBeenCalled();
    expect(onToolCall).toHaveBeenCalledTimes(1);
    expect(onToolCall).toHaveBeenCalledWith("system_config");
    expect(readResponsesToolError(create.mock.calls[2]?.[0], "call-progress"))
      .toContain("already staged");
  });
});

function installSiblingTextResponses(provider: OpenAIProvider, kind: ProviderKind) {
  if (kind === "openai-official") {
    const create = vi.fn()
      .mockResolvedValueOnce({ output: [
        responseMessage("这段正文不应发送"),
        responseFunctionCall("call-config", "system_config", mutationInput())
      ] })
      .mockResolvedValueOnce({ output: [responseMessage("当前回合已拒绝。")] });
    vi.spyOn(provider as never, "createClient").mockReturnValue({ responses: { create } });
    return;
  }
  if (kind === "openai-compatible") {
    const create = vi.fn()
      .mockResolvedValueOnce(chatToolResponse(
        "call-config",
        "system_config",
        mutationInput(),
        "这段正文不应发送"
      ))
      .mockResolvedValueOnce(chatTextResponse("当前回合已拒绝。"));
    vi.spyOn(provider as never, "createChatClient").mockReturnValue({ chat: { completions: { create } } });
    return;
  }
  if (kind === "codex-responses") {
    vi.spyOn(provider as never, "getApiKey").mockReturnValue("codex-token");
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(codexResponse([
        responseMessage("这段正文不应发送"),
        responseFunctionCall("call-config", "system_config", mutationInput())
      ]))
      .mockResolvedValueOnce(codexResponse([responseMessage("当前回合已拒绝。")]))
    return;
  }
  if (kind === "anthropic-official") {
    vi.spyOn(provider as never, "getApiKey").mockReturnValue("anthropic-key");
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({
        content: [
          { type: "text", text: "这段正文不应发送" },
          { type: "tool_use", id: "call-config", name: "system_config", input: mutationInput() }
        ],
        stop_reason: "tool_use"
      }))
      .mockResolvedValueOnce(jsonResponse({
        content: [{ type: "text", text: "当前回合已拒绝。" }],
        stop_reason: "end_turn"
      }));
    return;
  }
  vi.spyOn(provider as never, "getApiKey").mockReturnValue("gemini-key");
  vi.spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(jsonResponse({ candidates: [{ content: { role: "model", parts: [
      { text: "这段正文不应发送" },
      { functionCall: { name: "system_config", args: mutationInput() } }
    ] } }] }))
    .mockResolvedValueOnce(jsonResponse({ candidates: [{ content: {
      role: "model",
      parts: [{ text: "当前回合已拒绝。" }]
    } }] }));
}

function systemConfigPort() {
  let staged = false;
  let rejected = false;
  const execute = vi.fn(async () => {
    staged = true;
    return { ok: true, staged: true };
  });
  const rejectTurn = vi.fn(() => {
    staged = false;
    rejected = true;
  });
  return {
    execute,
    mutationStaged: () => staged,
    rejectTurn,
    turnRejected: () => rejected
  } satisfies NonNullable<ProviderCompleteOptions["systemConfig"]>;
}

function mutationInput() {
  return {
    operation: "set_auto_reply",
    replyScope: "private",
    enabled: false,
    orchestratorEnabled: null,
    searchImplementation: null,
    bashAdminBackend: null,
    conversationId: null
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

function responseMessage(text: string) {
  return {
    type: "message",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text }]
  };
}

function responseFunctionCall(callId: string, name: string, args: Record<string, unknown>) {
  return {
    type: "function_call",
    name,
    call_id: callId,
    arguments: JSON.stringify(args),
    status: "completed"
  };
}

function chatToolResponse(
  callId: string,
  name: string,
  args: Record<string, unknown>,
  content: string | null
) {
  return {
    choices: [{
      finish_reason: "tool_calls",
      message: {
        role: "assistant",
        content,
        tool_calls: [{ id: callId, type: "function", function: { name, arguments: JSON.stringify(args) } }]
      }
    }]
  };
}

function chatTextResponse(text: string) {
  return { choices: [{ finish_reason: "stop", message: { role: "assistant", content: text } }] };
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

function readResponsesToolError(body: unknown, callId: string) {
  const input = (body as Record<string, any>)?.input;
  const output = Array.isArray(input)
    ? input.find((item: Record<string, unknown>) => item.type === "function_call_output" && item.call_id === callId)
    : undefined;
  return String(JSON.parse(String(output?.output)).error ?? "");
}
