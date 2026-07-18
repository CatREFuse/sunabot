// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { RegistryProviderToolExecutor } from "../../adapters/model/provider/toolExecutor.js";
import type { ProviderCompleteOptions } from "../../adapters/model/provider/contracts.js";
import type { OpenAIToolDefinition } from "../../services/agent/promptSystem.js";
import { assistantTextTool } from "../../services/tools/assistantTextTool.js";
import { codexTool } from "../../services/tools/definitions.js";
import { sendVoiceMessageTool } from "../../services/tools/sendConversationAssetTool.js";

describe("provider voice companion terminal turns", () => {
  it("returns visible text and voice together without delivering an intermediate message", () => {
    const onAssistantText = vi.fn();
    const onToolCall = vi.fn();
    const options = voiceOptions({ onAssistantText, onToolCall });
    const executor = new RegistryProviderToolExecutor();
    const definitions = executor.resolveDefinitions(options, [
      tool(sendVoiceMessageTool),
    ]);

    const turn = executor.companionTurn(
      [
        call("send_voice_message", "voice-1", {
          text: "おはよう、先生。",
          language: "ja",
        }),
      ],
      "おはよう、先生。",
      options,
      definitions,
    );

    expect(turn).toEqual({
      kind: "completed",
      text: "おはよう、先生。",
      voice: {
        text: "おはよう、先生。",
        language: "ja",
        callId: "voice-1",
        toolName: "send_voice_message",
      },
    });
    expect(onAssistantText).not.toHaveBeenCalled();
    expect(onToolCall).toHaveBeenCalledWith("send_voice_message");
  });

  it("turns assistant_text plus voice into one terminal companion result", () => {
    const onAssistantText = vi.fn();
    const onToolCall = vi.fn();
    const options = voiceOptions({ onAssistantText, onToolCall });
    const executor = new RegistryProviderToolExecutor();
    const definitions = executor.resolveDefinitions(options, [
      tool(assistantTextTool),
      tool(sendVoiceMessageTool),
    ]);

    expect(
      executor.companionTurn(
        [
          call("assistant_text", "text-1", { text: "おやすみなさい、先生。" }),
          call("send_voice_message", "voice-1", {
            text: "おやすみなさい、先生。",
            language: "ja",
          }),
        ],
        "",
        options,
        definitions,
      ),
    ).toMatchObject({
      kind: "completed",
      text: "おやすみなさい、先生。",
      messageOrigin: "assistant_text",
      voice: { callId: "voice-1", language: "ja" },
    });
    expect(onAssistantText).not.toHaveBeenCalled();
    expect(onToolCall.mock.calls.map(([name]) => name)).toEqual([
      "assistant_text",
      "send_voice_message",
    ]);
  });

  it("allows a deferred dispatch_message to carry the same voice companion", () => {
    const options = voiceOptions({ asyncCodex: true });
    const executor = new RegistryProviderToolExecutor();
    const definitions = executor.resolveDefinitions(options, [
      tool(codexTool),
      tool(sendVoiceMessageTool),
    ]);

    expect(
      executor.companionTurn(
        [
          call("codex", "codex-1", {
            task: "检查发布包",
            kind: "local",
            dispatch_message: "我会认真把它检查完。",
          }),
          call("send_voice_message", "voice-1", {
            text: "我会认真把它检查完。",
            language: "ja",
          }),
        ],
        "",
        options,
        definitions,
      ),
    ).toEqual({
      kind: "deferred",
      acknowledgement: "我会认真把它检查完。",
      toolCall: {
        name: "codex",
        callId: "codex-1",
        arguments: { task: "检查发布包", kind: "local" },
      },
      voice: {
        text: "我会认真把它检查完。",
        language: "ja",
        callId: "voice-1",
        toolName: "send_voice_message",
      },
    });
  });

  it("fails closed for an unconfigured language", () => {
    const options = voiceOptions();
    const executor = new RegistryProviderToolExecutor();
    const definitions = executor.resolveDefinitions(options, [
      tool(sendVoiceMessageTool),
    ]);
    expect(() =>
      executor.companionTurn(
        [
          call("send_voice_message", "voice-1", {
            text: "早安。",
            language: "zh",
          }),
        ],
        "早安。",
        options,
        definitions,
      ),
    ).toThrow("language zh is not configured");
  });
});

function voiceOptions(
  overrides: Partial<ProviderCompleteOptions> = {},
): ProviderCompleteOptions {
  return {
    voice: { enabled: true, languages: ["ja"], defaultLanguage: "ja" },
    ...overrides,
  };
}

function tool(value: Record<string, unknown>): OpenAIToolDefinition {
  return { type: "function", function: value as never };
}

function call(name: string, callId: string, args: Record<string, unknown>) {
  return {
    type: "function_call" as const,
    name,
    call_id: callId,
    arguments: JSON.stringify(args),
  };
}
