// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  parseVoiceCompanion,
  voiceReadableText,
} from "../../adapters/model/provider/voiceCompanion.js";

describe("voice companion tool contract", () => {
  it("accepts one voice call beside matching visible text", () => {
    expect(
      parseVoiceCompanion(
        [
          call("send_voice_message", "voice-1", {
            text: "おはよう、先生。",
            language: "ja",
          }),
        ],
        "おはよう、先生。",
        () => false,
      ),
    ).toMatchObject({
      source: "text",
      text: "おはよう、先生。",
      language: "ja",
      voiceCall: { call_id: "voice-1" },
    });
  });

  it("accepts assistant_text followed by voice and ignores emoji markers for equality", () => {
    expect(
      parseVoiceCompanion(
        [
          call("assistant_text", "text-1", {
            text: "おやすみなさい、先生。[/害羞]",
          }),
          call("send_voice_message", "voice-1", {
            text: "おやすみなさい、先生。",
            language: "ja",
          }),
        ],
        "",
        () => false,
      ),
    ).toMatchObject({
      source: "assistant_text",
      text: "おやすみなさい、先生。[/害羞]",
      language: "ja",
    });
    expect(voiceReadableText("前[/开心] 后 ")).toBe("前 后");
    expect(voiceReadableText("示例 \\[/开心]")).toBe("示例 \\[/开心]");
  });

  it("accepts a deferred dispatch followed by voice and strips dispatch_message from worker args", () => {
    expect(
      parseVoiceCompanion(
        [
          call("codex", "codex-1", {
            task: "检查发布包",
            kind: "local",
            dispatch_message: "我会认真把它检查完。",
          }),
          call("send_voice_message", "voice-1", {
            text: "我会认真把它检查完。",
            language: "zh",
          }),
        ],
        "",
        (name) => name === "codex",
      ),
    ).toEqual({
      source: "dispatch_message",
      text: "我会认真把它检查完。",
      language: "zh",
      sourceCall: expect.objectContaining({ call_id: "codex-1" }),
      voiceCall: expect.objectContaining({ call_id: "voice-1" }),
      deferred: {
        name: "codex",
        callId: "codex-1",
        arguments: { task: "检查发布包", kind: "local" },
      },
    });
  });

  it.each([
    {
      title: "voice without text",
      calls: [
        call("send_voice_message", "voice", { text: "晚安。", language: "ja" }),
      ],
      sibling: "",
    },
    {
      title: "mismatched source",
      calls: [
        call("send_voice_message", "voice", { text: "晚安。", language: "ja" }),
      ],
      sibling: "早安。",
    },
    {
      title: "voice before assistant_text",
      calls: [
        call("send_voice_message", "voice", { text: "晚安。", language: "ja" }),
        call("assistant_text", "text", { text: "晚安。" }),
      ],
      sibling: "",
    },
    {
      title: "unsupported source tool",
      calls: [
        call("websearch", "search", { query: "news" }),
        call("send_voice_message", "voice", { text: "晚安。", language: "ja" }),
      ],
      sibling: "",
    },
    {
      title: "duplicate voice calls",
      calls: [
        call("send_voice_message", "voice-1", {
          text: "晚安。",
          language: "ja",
        }),
        call("send_voice_message", "voice-2", {
          text: "晚安。",
          language: "ja",
        }),
      ],
      sibling: "",
    },
    {
      title: "unsupported fields",
      calls: [
        call("send_voice_message", "voice", {
          text: "晚安。",
          language: "ja",
          path: "x.wav",
        }),
      ],
      sibling: "晚安。",
    },
  ])("fails closed for $title", ({ calls, sibling }) => {
    expect(() => parseVoiceCompanion(calls, sibling, () => false)).toThrow();
  });
});

function call(name: string, callId: string, args: Record<string, unknown>) {
  return {
    type: "function_call" as const,
    name,
    call_id: callId,
    arguments: JSON.stringify(args),
  };
}
