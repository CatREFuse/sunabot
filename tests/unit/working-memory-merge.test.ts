// @vitest-environment node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applicationDataStore } from "../../adapters/sqlite/applicationDataStore.js";
import {
  appendMemoryFacts,
  readMemorySourceEntries
} from "../../services/memory/memoryService.js";
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
    const [first, progress, completed] = await appendMemoryFacts(config, "working", [
      { fact: "海边用户（QQ 10001）在 7 月 1 日提出迁移。", userIds: ["10001"], userName: "海边用户", occurredAt: "2026-07-01T00:00:00.000Z" },
      { fact: "海边用户（QQ 10001）在 7 月 3 日开始迁移。", userIds: ["10001"], userName: "海边用户", occurredAt: "2026-07-03T00:00:00.000Z" },
      { fact: "海边用户（QQ 10001）在 7 月 5 日完成迁移。", userIds: ["10001"], userName: "海边用户", occurredAt: "2026-07-05T00:00:00.000Z" }
    ]);
    const complete = vi.fn(async (systemPrompt: string, messages: Array<{ content: string }>) => {
      const payload = parsePromptPayload(messages[0]!.content) as {
        previousWorkingMemories: Array<{ id: string; fact: string }>;
        messages: Array<{ text: string; at: string }>;
      };
      expect(systemPrompt).toContain("输出合并后的完整工作记忆集合");
      expect(systemPrompt).toContain("合并语义相同、相近、重复或存在因果关系的事实");
      expect(payload.previousWorkingMemories).toEqual([
        expect.objectContaining({ id: first!.id, fact: "海边用户（QQ 10001）在 7 月 1 日提出迁移。" }),
        expect.objectContaining({ id: progress!.id, fact: "海边用户（QQ 10001）在 7 月 3 日开始迁移。" }),
        expect.objectContaining({ id: completed!.id, fact: "海边用户（QQ 10001）在 7 月 5 日完成迁移。" })
      ]);
      expect(payload.messages).toEqual([expect.objectContaining({
        text: "迁移已经完成",
        at: expect.stringMatching(/^2026-07-10T\d{2}:00:00\.000[+-]\d{2}:\d{2}$/)
      })]);
      return JSON.stringify({
        facts: [{
          id: first!.id,
          fact: "我注意到海边用户（QQ 10001）从 7 月 1 日提出迁移、7 月 3 日开始，到 7 月 5 日完成，连续进展最终让我安心。",
          userIds: ["10001"],
          addressNames: ["海边用户"],
          occurredAt: "2026-07-01T00:00:00.000Z",
          occurredEndAt: "2026-07-05T00:00:00.000Z"
        }],
        allPreviousMemoriesInvalidated: false
      });
    });
    const runtime = runtimeWithProvider(config, complete);

    const result = await mergeConversation(runtime, "迁移已经完成");

    expect(result).toMatchObject({ ok: true, beforeCount: 3, afterCount: 1, attempts: 1 });
    expect((await readMemorySourceEntries(config, "working"))).toEqual([
      expect.objectContaining({
        id: first!.id,
        text: "我注意到海边用户（QQ 10001）从 7 月 1 日提出迁移、7 月 3 日开始，到 7 月 5 日完成，连续进展最终让我安心。",
        userIds: ["10001"],
        addressNames: ["海边用户"],
        occurredAt: "2026-07-01T00:00:00.000Z",
        occurredEndAt: "2026-07-05T00:00:00.000Z"
      })
    ]);
    expect((await readMemorySourceEntries(config, "working"))[0]?.text).not.toContain("我记得");
    expect(complete).toHaveBeenCalledOnce();
  });

  it("accepts a valid empty set without a separate clear authorization gate", async () => {
    await appendMemoryFacts(config, "working", [{ fact: "必须保留的旧事实" }]);
    const runtime = runtimeWithProvider(config, vi.fn(async () => JSON.stringify({
      facts: [],
      allPreviousMemoriesInvalidated: false
    })));

    const result = await runtime.consolidateWorkingMemory();

    expect(result).toMatchObject({ ok: true, beforeCount: 1, afterCount: 0 });
    expect(await readMemorySourceEntries(config, "working")).toEqual([]);
  });

  it("accepts user self-narration without a host wording gate", async () => {
    await appendMemoryFacts(config, "working", [{ fact: "必须保留的旧事实" }]);
    const runtime = runtimeWithProvider(config, vi.fn(async () => JSON.stringify({
      facts: [{
        fact: "我喜欢摄影。",
        userIds: ["10001"],
        userName: "海边用户"
      }],
      allPreviousMemoriesInvalidated: false
    })));

    const result = await mergeConversation(runtime, "我喜欢摄影");

    expect(result).toMatchObject({ ok: true, status: "applied" });
    expect((await readMemorySourceEntries(config, "working")).map((entry) => entry.text)).toEqual([
      "我喜欢摄影。"
    ]);
  });

  it("accepts every nonempty returned fact without semantic validation", async () => {
    await appendMemoryFacts(config, "working", [{ fact: "必须保留的旧事实" }]);
    const workingMemoryPath = path.join(config.persona.agentWorkspace, "WORKING_MEMORY.md");
    const originalDocument = await fs.readFile(workingMemoryPath, "utf8");
    const [related] = await appendMemoryFacts(config, "long_term", [{
      fact: "海边用户正在推进工作，也喜欢摄影。"
    }]);
    const runtime = runtimeWithProvider(config, vi.fn(async () => JSON.stringify({
      facts: [{
        fact: "我知道海边用户（QQ 10001）正在推进工作，这让我很在意。",
        userIds: ["10001"],
        userName: "海边用户"
      }, {
        fact: "我喜欢摄影。",
        userIds: ["10001"],
        userName: "海边用户"
      }],
      allPreviousMemoriesInvalidated: false
    })));

    const result = await mergeConversation(runtime, "继续推进，我也喜欢摄影");

    expect(result).toMatchObject({ ok: true, status: "applied" });
    expect((await readMemorySourceEntries(config, "working")).map((entry) => entry.text)).toEqual([
      "我知道海边用户（QQ 10001）正在推进工作，这让我很在意。",
      "我喜欢摄影。"
    ]);
    expect(await fs.readFile(workingMemoryPath, "utf8")).not.toBe(originalDocument);
    expect(applicationDataStore(config).listRecallStats([related!.id])[0]?.recallCount ?? 0).toBe(0);
  });

  it("continues the batch when profile wording would previously have failed semantic validation", async () => {
    await appendMemoryFacts(config, "working", [{ fact: "必须保留的旧事实" }]);
    const runtime = runtimeWithProvider(config, vi.fn(async () => "unused"));
    vi.spyOn(runtime, "compressUserProfiles").mockResolvedValue([{
      fact: "我知道海边用户（QQ 10001）喜欢测试。",
      userIds: ["10001"],
      userName: "海边用户"
    }, {
      fact: "我喜欢摄影。",
      userIds: ["10001"],
      userName: "海边用户"
    }]);
    const workingMerge = vi.spyOn(runtime, "requestWorkingMemoryMerge").mockResolvedValue({
      facts: [{ fact: "工作记忆正文" }],
      allPreviousMemoriesInvalidated: false
    });

    const result = await runtime.processMemoryClaim({
      conversation: {
        id: "group:30003",
        scope: "user_group",
        title: "测试群",
        userId: 10001,
        groupId: 30003
      },
      batchId: "profile-gate-batch",
      messageIds: ["message-1"],
      messages: [{
        id: "message-1",
        sequence: 1,
        role: "user",
        text: "我喜欢摄影",
        at: "2026-07-10T00:00:00.000Z",
        userId: 10001,
        senderName: "海边用户",
        imageCount: 0,
        quoteCount: 0
      }],
      attemptMessageCount: 1
    });

    expect(result).toBe(true);
    expect(workingMerge).toHaveBeenCalledOnce();
    expect((await readMemorySourceEntries(config, "working")).map((entry) => entry.text)).toEqual([
      "工作记忆正文"
    ]);
    expect(await readMemorySourceEntries(config, "long_term")).toEqual([]);
    expect((await readMemorySourceEntries(config, "user_profile"))[0]?.text).toContain("我知道海边用户（QQ 10001）喜欢测试。");
    expect((await readMemorySourceEntries(config, "user_profile"))[0]?.text).toContain("我喜欢摄影。");
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

  it("does not use the legacy clear signal as a write gate", async () => {
    await appendMemoryFacts(config, "working", [{ fact: "原事实" }]);
    const runtime = runtimeWithProvider(config, vi.fn(async () => JSON.stringify({
      facts: [{ fact: "仍然存在的事实" }],
      allPreviousMemoriesInvalidated: true
    })));

    const result = await runtime.consolidateWorkingMemory();

    expect(result).toMatchObject({ ok: true, beforeCount: 1, afterCount: 1 });
    expect((await readMemorySourceEntries(config, "working")).map((entry) => entry.text)).toEqual(["仍然存在的事实"]);
  });

  it("keeps valid facts when the same model array contains empty items", async () => {
    await appendMemoryFacts(config, "working", [{ fact: "原事实" }]);
    const runtime = runtimeWithProvider(config, vi.fn(async () => JSON.stringify({
      facts: [
        { fact: "" },
        { fact: "有效事实" }
      ],
      allPreviousMemoriesInvalidated: false
    })));

    const result = await runtime.consolidateWorkingMemory();

    expect(result).toMatchObject({ ok: true, beforeCount: 1, afterCount: 1 });
    expect((await readMemorySourceEntries(config, "working")).map((entry) => entry.text)).toEqual(["有效事实"]);
  });

  it("retries once with the latest complete snapshot after a concurrent write", async () => {
    const [original] = await appendMemoryFacts(config, "working", [{ fact: "原事实" }]);
    const payloads: Array<{ previousWorkingMemories: Array<{ id: string; fact: string }> }> = [];
    const complete = vi.fn(async (_systemPrompt: string, messages: Array<{ content: string }>) => {
      const payload = parsePromptPayload(messages[0]!.content) as {
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

  it("does not include or mutate long-term memory while retrying a working-memory snapshot", async () => {
    const [related] = await appendMemoryFacts(config, "long_term", [{
      fact: "测试群的长期记忆保持独立"
    }]);
    await appendMemoryFacts(config, "working", [{ fact: "原事实" }]);
    let providerCalls = 0;
    const complete = vi.fn(async (_systemPrompt: string, messages: Array<{ content: string }>) => {
      const payload = parsePromptPayload(messages[0]!.content) as {
        previousWorkingMemories: Array<{ id: string; fact: string }>;
        relatedLongTermMemories?: Array<{ id: string }>;
      };
      expect(payload.relatedLongTermMemories).toBeUndefined();
      providerCalls += 1;
      if (providerCalls === 1) {
        await appendMemoryFacts(config, "working", [{ fact: "并发写入事实" }]);
      }
      return JSON.stringify({
        facts: payload.previousWorkingMemories.map((entry) => ({ id: entry.id, fact: entry.fact })),
        allPreviousMemoriesInvalidated: false
      });
    });
    const runtime = runtimeWithProvider(config, complete);
    const batchId = `batch-${"x".repeat(400)}`;
    const context = {
      conversation: { id: "group:30003", scope: "user_group", title: "测试群" },
      participants: [],
      messages: [],
      metadata: { source: "sunabot.memory.batch", batchId }
    };

    await expect(runtime.mergeWorkingMemory(context)).resolves.toMatchObject({
      ok: true,
      attempts: 2
    });
    await expect(runtime.mergeWorkingMemory({
      ...context,
      metadata: { ...context.metadata }
    })).resolves.toMatchObject({ ok: true, attempts: 1 });

    expect(applicationDataStore(config).listRecallStats([related!.id])[0]?.recallCount ?? 0).toBe(0);
    expect((await readMemorySourceEntries(config, "long_term")).map((entry) => entry.text))
      .toEqual(["测试群的长期记忆保持独立"]);
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
        addressNames: string[];
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
    addressNames: ["海边用户"],
    isAdmin: false
  }]);
}

function parsePromptPayload(content: string) {
  const marker = "</time_context>";
  const payload = content.includes(marker)
    ? content.slice(content.indexOf(marker) + marker.length).trim()
    : content;
  return JSON.parse(payload);
}
