// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  parseVoiceCompanion,
} from "../../adapters/model/provider/voiceCompanion.js";

describe("voice companion tool contract", () => {
  it("keeps long visible text intact beside a short voice message", () => {
    const text = "完整正文".repeat(1_100);
    expect(parseVoiceCompanion([
      call("assistant_text", "text", { text }),
      call("send_voice_message", "voice", { text: "读完了。" }),
    ], "", () => false)).toMatchObject({ text, voiceText: "读完了。" });
  });

  it("accepts one voice call beside matching visible text", () => {
    expect(
      parseVoiceCompanion(
        [
          call("send_voice_message", "voice-1", {
            text: "おはよう、先生。",
          }),
        ],
        "おはよう、先生。",
        () => false,
      ),
    ).toMatchObject({
      source: "text",
      text: "おはよう、先生。",
      voiceCall: { call_id: "voice-1" },
    });
  });

  it("preserves assistant_text emoji markers separately from the voice text", () => {
    expect(
      parseVoiceCompanion(
        [
          call("assistant_text", "text-1", {
            text: "おやすみなさい、先生。[/害羞]",
          }),
          call("send_voice_message", "voice-1", {
            text: "おやすみなさい、先生。",
          }),
        ],
        "",
        () => false,
      ),
    ).toMatchObject({
      source: "assistant_text",
      text: "おやすみなさい、先生。[/害羞]",
      voiceText: "おやすみなさい、先生。",
    });
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
          }),
        ],
        "",
        (name) => name === "codex",
      ),
    ).toEqual({
      source: "dispatch_message",
      text: "我会认真把它检查完。",
      voiceText: "我会认真把它检查完。",
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
        call("send_voice_message", "voice", { text: "晚安。" }),
      ],
      sibling: "",
      text: "晚安。",
    },
    {
      title: "mismatched source",
      calls: [
        call("send_voice_message", "voice", { text: "晚安。" }),
      ],
      sibling: "早安。",
      text: "早安。",
    },
    {
      title: "voice before assistant_text",
      calls: [
        call("send_voice_message", "voice", { text: "晚安。" }),
        call("assistant_text", "text", { text: "晚安。" }),
      ],
      sibling: "",
      text: "晚安。",
    },
    {
      title: "source arguments with additional fields and sibling text",
      calls: [
        call("assistant_text", "text", { text: "晚安。", note: "可选附加说明" }),
        call("send_voice_message", "voice", { text: "祝你好梦。" }),
      ],
      sibling: "今天辛苦了。",
      text: "今天辛苦了。\n晚安。",
    },
  ])("accepts $title", ({ calls, sibling, text }) => {
    expect(parseVoiceCompanion(calls, sibling, () => false)).toMatchObject({ text });
  });

  it("preserves distinct visible and voice text with a reordered deferred call", () => {
    expect(parseVoiceCompanion([
      call("send_voice_message", "voice", { text: "马上开始。" }),
      call("codex", "worker", { task: "检查", dispatch_message: "任务已开始。" }),
    ], "", (name) => name === "codex")).toMatchObject({
      text: "任务已开始。",
      voiceText: "马上开始。",
      deferred: { name: "codex", callId: "worker" }
    });
  });

  it.each([
    {
      title: "invalid voice text",
      calls: [call("send_voice_message", "voice", { text: null })],
      sibling: "晚安。",
    },
    {
      title: "unsupported source tool",
      calls: [
        call("websearch", "search", { query: "news" }),
        call("send_voice_message", "voice", { text: "晚安。" }),
      ],
      sibling: "",
    },
    {
      title: "duplicate voice calls",
      calls: [
        call("send_voice_message", "voice-1", {
          text: "晚安。",
        }),
        call("send_voice_message", "voice-2", {
          text: "晚安。",
        }),
      ],
      sibling: "",
    },
    {
      title: "unsupported fields",
      calls: [
        call("send_voice_message", "voice", {
          text: "晚安。",
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
