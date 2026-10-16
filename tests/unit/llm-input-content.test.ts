// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { defaultConfig } from "../../src/config.js";
import { RuntimeAir } from "../../src/runtime/air.js";
import { buildMemoryPromptVariables, buildUserPrompt } from "../../src/runtime/conversationMemoryHelpers.js";
import { buildAsyncToolCompletionPrompt } from "../../src/runtime/infrastructure.js";
import { normalizeSelfiePrompt } from "../../src/runtime/selfieHelpers.js";
import { readCallbackInput } from "../../services/agent/callbackInput.js";
import type { ParsedIncomingMessage } from "../../src/types.js";

vi.mock("../../services/air/public.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../services/air/public.js")>(),
  readAirKnowledge: vi.fn(async () => ({ content: "原有知识", revision: "air-revision" })),
  replaceAirKnowledge: vi.fn(async () => ({
    status: "unchanged",
    current: { content: "原有知识", revision: "air-revision" }
  }))
}));
vi.mock("../../adapters/observability/requestLog.js", () => ({
  appendRequestLog: vi.fn(async () => undefined)
}));

const incoming: ParsedIncomingMessage = {
  schemaVersion: 1,
  accountId: "primary",
  scope: "private",
  userId: 10001,
  messageId: 77,
  time: "2026-10-14T12:00:00+08:00",
  text: "请求",
  sender: {},
  segments: [],
  media: [],
  attachments: [],
  replyMessageIds: [],
  quoteReferences: []
};

describe("LLM input content preservation", () => {
  it("preserves all selected working, long-term and user-profile memory text", () => {
    const text = `${"完整记忆".repeat(800)}记忆末尾`;
    const entries = (["working", "long_term", "user_profile"] as const).map((source) => ({
      id: source, source, sourceTitle: source, fileName: "", editable: false,
      key: source, value: text, text, field: "fact"
    }));
    const variables = buildMemoryPromptVariables({
      working: [entries[0]!], longTerm: [entries[1]!], userProfile: [entries[2]!]
    });
    for (const value of Object.values(variables)) expect(value.includes(text)).toBe(true);
  });

  it("preserves the complete current message and attachment context", () => {
    const text = `${"当前输入".repeat(3_000)}消息末尾`;
    const attachment = `${"文件内容".repeat(3_000)}附件末尾`;
    const prompt = buildUserPrompt(incoming, text, true, { userId: "10001", name: "Admin" }, attachment);
    expect(prompt.includes(text)).toBe(true);
    expect(prompt.includes(attachment)).toBe(true);
  });

  it("preserves a complete large asynchronous result in structured callback input", () => {
    const report = `${"完整工具报告".repeat(25_000)}报告末尾`;
    const prompt = buildAsyncToolCompletionPrompt({
      type: "tool_result",
      toolJobId: "job-1",
      providerCallId: "call-1",
      toolName: "codex",
      originalRequest: { incoming },
      arguments: { task: "读取报告", __sunabot_frozen_inputs: [{ relativePath: "private/input.txt" }] },
      outcome: { status: "succeeded", result: { report }, error: undefined }
    });
    const payload = readCallbackInput(prompt)?.payload as {
      toolResult: { outcome: { result: { report: string } }; arguments: Record<string, unknown> }
    };
    expect(typeof payload.toolResult).toBe("object");
    expect(payload.toolResult.outcome.result.report === report).toBe(true);
    expect(payload.toolResult.arguments).toEqual({ task: "读取报告" });
  });

  it("preserves long messages in AIR while retaining its history count window", async () => {
    const content = `${"完整会话".repeat(3_000)}会话末尾`;
    const renderPromptRequest = vi.fn(async (_id: string, _variables: Readonly<Record<string, unknown>>) => ({
      messages: [], response_format: { type: "text" }
    }));
    const runtime = new RuntimeAir({
      config: defaultConfig(),
      conversationRecords: new Map(),
      getProvider: vi.fn(),
      renderPromptRequest,
      completePrompt: vi.fn(async () => "原有知识")
    });
    const messages = Array.from({ length: 65 }, (_, index) => ({
      role: "user" as const,
      content: index === 64 ? content : `message-${index}`
    }));
    await expect(runtime.toolPort(incoming, messages).execute({ insight: "稳定约定" }))
      .resolves.toMatchObject({ ok: true, updated: false });
    const context = renderPromptRequest.mock.calls[0]![1]["air.conversation"] as {
      messages: Array<{ content: string }>
    };
    expect(context.messages).toHaveLength(64);
    expect(context.messages[0]!.content).toBe("message-1");
    expect(context.messages.at(-1)!.content === content).toBe(true);
  });

  it("preserves the full selfie scene before prompt rewriting", () => {
    const prompt = `${"完整画面".repeat(1_100)}画面末尾`;
    expect(normalizeSelfiePrompt(prompt) === prompt).toBe(true);
  });
});
