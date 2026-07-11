// @vitest-environment node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  appendMemoryFacts,
  readMemorySourceEntries
} from "../../src/memory.js";
import { SunaRuntime } from "../../src/runtime.js";
import type { AppConfig, ConversationRecord } from "../../src/types.js";
import { createAdminTestConfig } from "./admin-fixtures.js";

describe("working memory semantic merge", () => {
  let rootDir = "";
  let config: AppConfig;

  beforeEach(async () => {
    rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-working-memory-merge-"));
    config = createAdminTestConfig(rootDir);
  });

  afterEach(async () => {
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  it("sends all previous memories with the current messages and replaces them with the merged set", async () => {
    const [first, duplicate] = await appendMemoryFacts(config, "working", [
      { fact: "QQ 10001 喜欢海边。", userIds: ["10001"], time: "2026-07-01T00:00:00.000Z" },
      { fact: "10001 偏好海边旅行。", userIds: ["10001"], time: "2026-07-02T00:00:00.000Z" }
    ]);
    const complete = vi.fn(async (systemPrompt: string, messages: Array<{ content: string }>) => {
      const payload = JSON.parse(messages[0]!.content) as {
        previousWorkingMemories: Array<{ id: string; fact: string }>;
        messages: Array<{ text: string }>;
      };
      expect(systemPrompt).toContain("输出合并后的完整工作记忆集合");
      expect(systemPrompt).toContain("合并语义重复或高度相近的事实");
      expect(payload.previousWorkingMemories).toEqual([
        expect.objectContaining({ id: first!.id, fact: "QQ 10001 喜欢海边。" }),
        expect.objectContaining({ id: duplicate!.id, fact: "10001 偏好海边旅行。" })
      ]);
      expect(payload.messages).toEqual([expect.objectContaining({ text: "我更喜欢有礁石的海边" })]);
      return JSON.stringify({
        facts: [{
          id: first!.id,
          fact: "QQ 10001 喜欢有礁石的海边旅行。",
          userIds: ["10001"],
          time: "2026-07-01T00:00:00.000Z/2026-07-10T00:00:00.000Z"
        }],
        allPreviousMemoriesInvalidated: false
      });
    });
    const runtime = runtimeWithProvider(config, complete);

    const result = await mergeConversation(runtime, "我更喜欢有礁石的海边");

    expect(result).toMatchObject({ ok: true, beforeCount: 2, afterCount: 1, attempts: 1 });
    expect((await readMemorySourceEntries(config, "working"))).toEqual([
      expect.objectContaining({
        id: first!.id,
        text: "QQ 10001 喜欢有礁石的海边旅行。",
        userIds: ["10001"]
      })
    ]);
    expect(complete).toHaveBeenCalledOnce();
  });

  it("keeps nonempty memory when the model returns an unauthorized empty set", async () => {
    await appendMemoryFacts(config, "working", [{ fact: "必须保留的旧事实" }]);
    const runtime = runtimeWithProvider(config, vi.fn(async () => JSON.stringify({
      facts: [],
      allPreviousMemoriesInvalidated: false
    })));

    const result = await runtime.consolidateWorkingMemory();

    expect(result).toMatchObject({ ok: false, status: "empty_not_authorized" });
    expect((await readMemorySourceEntries(config, "working")).map((entry) => entry.text)).toEqual([
      "必须保留的旧事实"
    ]);
  });

  it("accepts an explicit signal when every previous fact is invalidated", async () => {
    await appendMemoryFacts(config, "working", [{ fact: "已经失效的唯一事实" }]);
    const runtime = runtimeWithProvider(config, vi.fn(async () => JSON.stringify({
      facts: [],
      allPreviousMemoriesInvalidated: true
    })));

    const result = await runtime.consolidateWorkingMemory();

    expect(result).toMatchObject({ ok: true, beforeCount: 1, afterCount: 0 });
    expect(await readMemorySourceEntries(config, "working")).toEqual([]);
  });

  it("rejects a clear signal combined with nonempty facts", async () => {
    await appendMemoryFacts(config, "working", [{ fact: "原事实" }]);
    const runtime = runtimeWithProvider(config, vi.fn(async () => JSON.stringify({
      facts: [{ fact: "仍然存在的事实" }],
      allPreviousMemoriesInvalidated: true
    })));

    const result = await runtime.consolidateWorkingMemory();

    expect(result).toMatchObject({ ok: false, status: "model_invalid" });
    expect((await readMemorySourceEntries(config, "working")).map((entry) => entry.text)).toEqual(["原事实"]);
  });

  it("retries once with the latest complete snapshot after a concurrent write", async () => {
    const [original] = await appendMemoryFacts(config, "working", [{ fact: "原事实" }]);
    const payloads: Array<{ previousWorkingMemories: Array<{ id: string; fact: string }> }> = [];
    const complete = vi.fn(async (_systemPrompt: string, messages: Array<{ content: string }>) => {
      const payload = JSON.parse(messages[0]!.content) as {
        previousWorkingMemories: Array<{ id: string; fact: string }>;
      };
      payloads.push(payload);
      if (payloads.length === 1) {
        await appendMemoryFacts(config, "working", [{ fact: "并发写入事实" }]);
      }
      return JSON.stringify({
        facts: payload.previousWorkingMemories.map((entry) => ({ id: entry.id, fact: entry.fact })),
        allPreviousMemoriesInvalidated: false
      });
    });
    const runtime = runtimeWithProvider(config, complete);

    const result = await runtime.consolidateWorkingMemory();

    expect(result).toMatchObject({ ok: true, beforeCount: 2, afterCount: 2, attempts: 2 });
    expect(payloads[0]!.previousWorkingMemories).toHaveLength(1);
    expect(payloads[1]!.previousWorkingMemories).toEqual([
      expect.objectContaining({ id: original!.id, fact: "原事实" }),
      expect.objectContaining({ fact: "并发写入事实" })
    ]);
    expect(complete).toHaveBeenCalledTimes(2);
  });
});

function runtimeWithProvider(
  config: AppConfig,
  complete: (systemPrompt: string, messages: Array<{ content: string }>) => Promise<string>
) {
  const runtime = new SunaRuntime(config, { attachmentService: {} as never });
  (runtime as unknown as {
    getProviderForModel: () => { complete: typeof complete };
  }).getProviderForModel = () => ({ complete });
  return runtime;
}

async function mergeConversation(runtime: SunaRuntime, text: string) {
  const record: ConversationRecord = {
    id: "group:30003",
    scope: "user_group",
    title: "测试群",
    userId: 10001,
    groupId: 30003,
    messageCount: 1,
    lastAt: "2026-07-10T00:00:00.000Z",
    lastText: text,
    messages: []
  };
  return (runtime as unknown as {
    mergeConversationWorkingMemory(
      record: ConversationRecord,
      batch: Array<{ sequence: number; message: ConversationRecord["messages"][number] }>,
      participants: Array<{
        userId: string;
        names: string[];
        currentName: string;
        addressName: string;
        isAdmin: boolean;
      }>
    ): Promise<unknown>;
  }).mergeConversationWorkingMemory(record, [{
    sequence: 1,
    message: {
      id: "message-1",
      role: "user",
      text,
      at: "2026-07-10T00:00:00.000Z",
      userId: 10001,
      senderName: "海边用户"
    }
  }], [{
    userId: "10001",
    names: ["海边用户"],
    currentName: "海边用户",
    addressName: "海边用户",
    isAdmin: false
  }]);
}
