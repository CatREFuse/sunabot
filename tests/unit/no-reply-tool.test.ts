// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderConfig, ProviderKind } from "../../src/types.js";

const appendRequestLog = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("../../src/requestLog.js", () => ({ appendRequestLog }));

import { OpenAIProvider } from "../../adapters/model/openaiProvider.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("no_reply provider termination", () => {
  it("terminates OpenAI Responses without delivering sibling assistant text", async () => {
    const provider = new OpenAIProvider(providerConfig("openai-official"));
    const create = vi.fn(async () => ({
      output: [
        responseMessage("这段正文不应发送"),
        responseFunctionCall("call-openai-no-reply")
      ]
    }));
    vi.spyOn(provider as never, "createClient").mockReturnValue({ responses: { create } });
    const onAssistantText = vi.fn();
    const onToolCall = vi.fn();

    await expect(provider.completeTurn("system", [{ role: "user", content: "到这里即可" }], {
      allowNoReply: true,
      onAssistantText,
      onToolCall
    })).resolves.toEqual({ kind: "no_reply" });

    expect(onAssistantText).not.toHaveBeenCalled();
    expect(onToolCall).toHaveBeenCalledWith("no_reply");
    expect((create.mock.calls[0]?.[0] as Record<string, any>).tools)
      .toEqual(expect.arrayContaining([expect.objectContaining({ name: "no_reply" })]));
  });

  it("terminates OpenAI-compatible Chat Completions without delivering sibling assistant text", async () => {
    const provider = new OpenAIProvider(providerConfig("openai-compatible"));
    const create = vi.fn(async () => ({
      choices: [{
        finish_reason: "tool_calls",
        message: {
          role: "assistant",
          content: "这段正文不应发送",
          tool_calls: [{
            id: "call-chat-no-reply",
            type: "function",
            function: { name: "no_reply", arguments: "{}" }
          }]
        }
      }]
    }));
    vi.spyOn(provider as never, "createChatClient").mockReturnValue({ chat: { completions: { create } } });
    const onAssistantText = vi.fn();

    await expect(provider.completeTurn("system", [{ role: "user", content: "到这里即可" }], {
      allowNoReply: true,
      onAssistantText
    })).resolves.toEqual({ kind: "no_reply" });

    expect(onAssistantText).not.toHaveBeenCalled();
    const tools = (create.mock.calls[0]?.[0] as Record<string, any>).tools;
    expect(tools.map((tool: Record<string, any>) => tool.function.name)).toContain("no_reply");
  });

  it("terminates Codex Responses without delivering sibling assistant text", async () => {
    const provider = new OpenAIProvider(providerConfig("codex-responses"));
    vi.spyOn(provider as never, "getApiKey").mockReturnValue("codex-token");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(codexResponse([
      responseMessage("这段正文不应发送"),
      responseFunctionCall("call-codex-no-reply")
    ]));
    const onAssistantText = vi.fn();

    await expect(provider.completeTurn("system", [{ role: "user", content: "到这里即可" }], {
      allowNoReply: true,
      onAssistantText
    })).resolves.toEqual({ kind: "no_reply" });

    expect(onAssistantText).not.toHaveBeenCalled();
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as Record<string, any>;
    expect(body.tools.map((tool: Record<string, unknown>) => tool.name)).toContain("no_reply");
  });

  it("terminates Anthropic Messages without delivering sibling assistant text", async () => {
    const provider = new OpenAIProvider(providerConfig("anthropic-official"));
    vi.spyOn(provider as never, "getApiKey").mockReturnValue("anthropic-key");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({
      content: [
        { type: "text", text: "这段正文不应发送" },
        { type: "tool_use", id: "call-anthropic-no-reply", name: "no_reply", input: {} }
      ],
      stop_reason: "tool_use"
    }));
    const onAssistantText = vi.fn();

    await expect(provider.completeTurn("system", [{ role: "user", content: "到这里即可" }], {
      allowNoReply: true,
      onAssistantText
    })).resolves.toEqual({ kind: "no_reply" });

    expect(onAssistantText).not.toHaveBeenCalled();
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as Record<string, any>;
    expect(body.tools.map((tool: Record<string, unknown>) => tool.name)).toContain("no_reply");
  });

  it("terminates Gemini generateContent without delivering sibling assistant text", async () => {
    const provider = new OpenAIProvider(providerConfig("gemini-official"));
    vi.spyOn(provider as never, "getApiKey").mockReturnValue("gemini-key");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({
      candidates: [{
        content: {
          role: "model",
          parts: [
            { text: "这段正文不应发送" },
            { functionCall: { name: "no_reply", args: {} } }
          ]
        }
      }]
    }));
    const onAssistantText = vi.fn();

    await expect(provider.completeTurn("system", [{ role: "user", content: "到这里即可" }], {
      allowNoReply: true,
      onAssistantText
    })).resolves.toEqual({ kind: "no_reply" });

    expect(onAssistantText).not.toHaveBeenCalled();
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as Record<string, any>;
    expect(body.tools[0].functionDeclarations.map((tool: Record<string, unknown>) => tool.name))
      .toContain("no_reply");
  });
});

describe("send_file provider response exclusivity", () => {
  it("rejects OpenAI Responses sibling text before text or file callbacks", async () => {
    const provider = new OpenAIProvider(providerConfig("openai-official"));
    const create = vi.fn()
      .mockResolvedValueOnce({ output: [
        responseMessage("这段正文不应发送"),
        responseFunctionCall("call-openai-send-file", "send_file", sendFileArguments())
      ] })
      .mockResolvedValueOnce({ output: [responseMessage("已取消冲突调用")] });
    vi.spyOn(provider as never, "createClient").mockReturnValue({ responses: { create } });
    const callbacks = sendFileCallbacks();

    await expect(provider.completeTurn("system", [{ role: "user", content: "发送报告" }], callbacks.options))
      .resolves.toEqual({ kind: "completed", text: "已取消冲突调用" });
    assertSendFileCallbacksWereNotCalled(callbacks);
  });

  it("rejects Codex Responses sibling text before text or file callbacks", async () => {
    const provider = new OpenAIProvider(providerConfig("codex-responses"));
    vi.spyOn(provider as never, "getApiKey").mockReturnValue("codex-token");
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(codexResponse([
        responseMessage("这段正文不应发送"),
        responseFunctionCall("call-codex-send-file", "send_file", sendFileArguments())
      ]))
      .mockResolvedValueOnce(codexResponse([responseMessage("已取消冲突调用")]));
    const callbacks = sendFileCallbacks();

    await expect(provider.completeTurn("system", [{ role: "user", content: "发送报告" }], callbacks.options))
      .resolves.toEqual({ kind: "completed", text: "已取消冲突调用" });
    assertSendFileCallbacksWereNotCalled(callbacks);
  });

  it("rejects Chat Completions sibling text before text or file callbacks", async () => {
    const provider = new OpenAIProvider(providerConfig("openai-compatible"));
    const create = vi.fn()
      .mockResolvedValueOnce({
        choices: [{
          finish_reason: "tool_calls",
          message: {
            role: "assistant",
            content: "这段正文不应发送",
            tool_calls: [{
              id: "call-chat-send-file",
              type: "function",
              function: { name: "send_file", arguments: JSON.stringify(sendFileArguments()) }
            }]
          }
        }]
      })
      .mockResolvedValueOnce(chatTextResponse("已取消冲突调用"));
    vi.spyOn(provider as never, "createChatClient").mockReturnValue({ chat: { completions: { create } } });
    const callbacks = sendFileCallbacks();

    await expect(provider.completeTurn("system", [{ role: "user", content: "发送报告" }], callbacks.options))
      .resolves.toEqual({ kind: "completed", text: "已取消冲突调用" });
    assertSendFileCallbacksWereNotCalled(callbacks);
  });

  it("rejects Anthropic sibling text before text or file callbacks", async () => {
    const provider = new OpenAIProvider(providerConfig("anthropic-official"));
    vi.spyOn(provider as never, "getApiKey").mockReturnValue("anthropic-key");
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({
        content: [
          { type: "text", text: "这段正文不应发送" },
          { type: "tool_use", id: "call-anthropic-send-file", name: "send_file", input: sendFileArguments() }
        ],
        stop_reason: "tool_use"
      }))
      .mockResolvedValueOnce(jsonResponse({
        content: [{ type: "text", text: "已取消冲突调用" }],
        stop_reason: "end_turn"
      }));
    const callbacks = sendFileCallbacks();

    await expect(provider.completeTurn("system", [{ role: "user", content: "发送报告" }], callbacks.options))
      .resolves.toEqual({ kind: "completed", text: "已取消冲突调用" });
    assertSendFileCallbacksWereNotCalled(callbacks);
  });

  it("rejects Gemini sibling text before text or file callbacks", async () => {
    const provider = new OpenAIProvider(providerConfig("gemini-official"));
    vi.spyOn(provider as never, "getApiKey").mockReturnValue("gemini-key");
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ candidates: [{ content: { role: "model", parts: [
        { text: "这段正文不应发送" },
        { functionCall: { name: "send_file", args: sendFileArguments() } }
      ] } }] }))
      .mockResolvedValueOnce(jsonResponse({ candidates: [{ content: { role: "model", parts: [
        { text: "已取消冲突调用" }
      ] } }] }));
    const callbacks = sendFileCallbacks();

    await expect(provider.completeTurn("system", [{ role: "user", content: "发送报告" }], callbacks.options))
      .resolves.toEqual({ kind: "completed", text: "已取消冲突调用" });
    assertSendFileCallbacksWereNotCalled(callbacks);
  });
});

describe("cross-round no_reply ordering", () => {
  it("returns a tool error after OpenAI Responses already delivered assistant_text", async () => {
    const provider = new OpenAIProvider(providerConfig("openai-official"));
    const create = vi.fn()
      .mockResolvedValueOnce({ output: [responseFunctionCall("call-progress", "assistant_text", { text: "处理中" })] })
      .mockResolvedValueOnce({ output: [responseFunctionCall("call-late-no-reply")] })
      .mockResolvedValueOnce({ output: [responseMessage("处理完成")] });
    vi.spyOn(provider as never, "createClient").mockReturnValue({ responses: { create } });
    const onAssistantText = vi.fn();

    await expect(provider.completeTurn("system", [{ role: "user", content: "执行任务" }], {
      allowNoReply: true,
      onAssistantText
    })).resolves.toEqual({ kind: "completed", text: "处理完成" });

    expect(onAssistantText).toHaveBeenCalledWith("处理中", "assistant_text");
    expect(create).toHaveBeenCalledTimes(3);
    expect(readResponsesToolError(create.mock.calls[2]?.[0], "call-late-no-reply"))
      .toContain("before assistant text or any other tool");
  });

  it("returns a tool error after Chat Completions already delivered assistant_text", async () => {
    const provider = new OpenAIProvider(providerConfig("openai-compatible"));
    const create = vi.fn()
      .mockResolvedValueOnce(chatToolResponse("call-progress", "assistant_text", { text: "处理中" }))
      .mockResolvedValueOnce(chatToolResponse("call-late-no-reply", "no_reply", {}))
      .mockResolvedValueOnce(chatTextResponse("处理完成"));
    vi.spyOn(provider as never, "createChatClient").mockReturnValue({ chat: { completions: { create } } });

    await expect(provider.completeTurn("system", [{ role: "user", content: "执行任务" }], {
      allowNoReply: true,
      onAssistantText: vi.fn()
    })).resolves.toEqual({ kind: "completed", text: "处理完成" });

    const thirdBody = create.mock.calls[2]?.[0] as Record<string, any>;
    expect(JSON.parse(String(thirdBody.messages.find((message: Record<string, unknown>) => (
      message.role === "tool" && message.tool_call_id === "call-late-no-reply"
    ))?.content)).error).toContain("before assistant text or any other tool");
  });

  it("returns a tool error after Codex Responses already delivered assistant_text", async () => {
    const provider = new OpenAIProvider(providerConfig("codex-responses"));
    vi.spyOn(provider as never, "getApiKey").mockReturnValue("codex-token");
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(codexResponse([responseFunctionCall("call-progress", "assistant_text", { text: "处理中" })]))
      .mockResolvedValueOnce(codexResponse([responseFunctionCall("call-late-no-reply")]))
      .mockResolvedValueOnce(codexResponse([responseMessage("处理完成")]));

    await expect(provider.completeTurn("system", [{ role: "user", content: "执行任务" }], {
      allowNoReply: true,
      onAssistantText: vi.fn()
    })).resolves.toEqual({ kind: "completed", text: "处理完成" });

    const thirdBody = JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body));
    expect(readResponsesToolError(thirdBody, "call-late-no-reply"))
      .toContain("before assistant text or any other tool");
  });

  it("returns a tool error after Anthropic already delivered assistant_text", async () => {
    const provider = new OpenAIProvider(providerConfig("anthropic-official"));
    vi.spyOn(provider as never, "getApiKey").mockReturnValue("anthropic-key");
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({
        content: [{ type: "tool_use", id: "call-progress", name: "assistant_text", input: { text: "处理中" } }],
        stop_reason: "tool_use"
      }))
      .mockResolvedValueOnce(jsonResponse({
        content: [{ type: "tool_use", id: "call-late-no-reply", name: "no_reply", input: {} }],
        stop_reason: "tool_use"
      }))
      .mockResolvedValueOnce(jsonResponse({ content: [{ type: "text", text: "处理完成" }], stop_reason: "end_turn" }));

    await expect(provider.completeTurn("system", [{ role: "user", content: "执行任务" }], {
      allowNoReply: true,
      onAssistantText: vi.fn()
    })).resolves.toEqual({ kind: "completed", text: "处理完成" });

    const thirdBody = JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body)) as Record<string, any>;
    const toolResult = thirdBody.messages.flatMap((message: Record<string, any>) => (
      Array.isArray(message.content) ? message.content : []
    )).find((block: Record<string, unknown>) => block.tool_use_id === "call-late-no-reply");
    expect(JSON.parse(String(toolResult?.content)).error).toContain("before assistant text or any other tool");
  });

  it("returns a tool error after Gemini already delivered assistant_text", async () => {
    const provider = new OpenAIProvider(providerConfig("gemini-official"));
    vi.spyOn(provider as never, "getApiKey").mockReturnValue("gemini-key");
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ candidates: [{ content: { role: "model", parts: [
        { functionCall: { name: "assistant_text", args: { text: "处理中" } } }
      ] } }] }))
      .mockResolvedValueOnce(jsonResponse({ candidates: [{ content: { role: "model", parts: [
        { functionCall: { name: "no_reply", args: {} } }
      ] } }] }))
      .mockResolvedValueOnce(jsonResponse({ candidates: [{ content: { role: "model", parts: [{ text: "处理完成" }] } }] }));

    await expect(provider.completeTurn("system", [{ role: "user", content: "执行任务" }], {
      allowNoReply: true,
      onAssistantText: vi.fn()
    })).resolves.toEqual({ kind: "completed", text: "处理完成" });

    const thirdBody = JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body)) as Record<string, any>;
    const response = thirdBody.contents.flatMap((content: Record<string, any>) => content.parts ?? [])
      .map((part: Record<string, any>) => part.functionResponse)
      .find((item: Record<string, unknown> | undefined) => item?.name === "no_reply");
    expect(response.response.error).toContain("before assistant text or any other tool");
  });
});

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

function responseFunctionCall(
  callId: string,
  name = "no_reply",
  args: Record<string, unknown> = {}
) {
  return {
    type: "function_call",
    name,
    call_id: callId,
    arguments: JSON.stringify(args),
    status: "completed"
  };
}

function sendFileArguments() {
  return { path: "exports/report.txt", kind: "file", name: null };
}

function sendFileCallbacks() {
  const send = vi.fn(async () => ({ ok: true, queued: true }));
  const onAssistantText = vi.fn();
  const onToolCall = vi.fn();
  return {
    send,
    onAssistantText,
    onToolCall,
    options: {
      onAssistantText,
      onToolCall,
      conversationAssets: { enabled: true, send }
    }
  };
}

function assertSendFileCallbacksWereNotCalled(callbacks: ReturnType<typeof sendFileCallbacks>) {
  expect(callbacks.onAssistantText).not.toHaveBeenCalled();
  expect(callbacks.onToolCall).not.toHaveBeenCalled();
  expect(callbacks.send).not.toHaveBeenCalled();
}

function readResponsesToolError(body: unknown, callId: string) {
  const input = (body as Record<string, any>)?.input;
  const output = Array.isArray(input)
    ? input.find((item: Record<string, unknown>) => item.type === "function_call_output" && item.call_id === callId)
    : undefined;
  return String(JSON.parse(String(output?.output)).error ?? "");
}

function chatToolResponse(callId: string, name: string, args: Record<string, unknown>) {
  return {
    choices: [{
      finish_reason: "tool_calls",
      message: {
        role: "assistant",
        content: null,
        tool_calls: [{ id: callId, type: "function", function: { name, arguments: JSON.stringify(args) } }]
      }
    }]
  };
}

function chatTextResponse(text: string) {
  return {
    choices: [{ finish_reason: "stop", message: { role: "assistant", content: text } }]
  };
}

function codexResponse(output: Array<Record<string, unknown>>) {
  const events = output.map((item, outputIndex) => ({
    type: "response.output_item.done",
    output_index: outputIndex,
    item
  }));
  events.push({
    type: "response.completed",
    response: { status: "completed", output }
  } as never);
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
