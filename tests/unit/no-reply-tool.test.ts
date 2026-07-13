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

function responseFunctionCall(callId: string) {
  return {
    type: "function_call",
    name: "no_reply",
    call_id: callId,
    arguments: "{}",
    status: "completed"
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
