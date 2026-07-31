// @vitest-environment node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderCompleteOptions } from "../../adapters/model/openaiProvider.js";
import { applicationDataStore } from "../../adapters/sqlite/applicationDataStore.js";
import { AUXILIARY_MODEL_RESPONSE_TIMEOUT_MS } from "../../packages/contracts/model/modelGateway.js";
import {
  appendMemoryFacts,
  readMemorySourceEntries,
  readWorkingMemoryDocument,
  replaceWorkingMemoryDocument
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
    vi.useRealTimers();
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  it("accepts one memory Provider response after the former 120-second cutoff", async () => {
    vi.useFakeTimers();
    let resolveComplete: ((value: string) => void) | undefined;
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let capturedOptions: ProviderCompleteOptions | undefined;
    const complete = vi.fn((
      _systemPrompt: string,
      _messages: Array<{ content: string }>,
      options?: ProviderCompleteOptions
    ) => {
      capturedOptions = options;
      markStarted?.();
      return new Promise<string>((resolve) => {
        resolveComplete = resolve;
      });
    });
    const runtime = runtimeWithProvider(config, complete);

    const pending = mergeConversation(runtime, "记忆处理最长等待窗口是十分钟");
    await started;
    await vi.advanceTimersByTimeAsync(120_001);

    expect(complete).toHaveBeenCalledOnce();
    expect(capturedOptions?.modelRequestMaxRetries).toBe(0);
    expect(capturedOptions?.modelRequestAttemptTimeoutMs)
      .toBe(AUXILIARY_MODEL_RESPONSE_TIMEOUT_MS);
    expect(capturedOptions?.signal?.aborted).toBe(false);

    resolveComplete?.(JSON.stringify({
      facts: [{ fact: "我会让记忆处理等待最长十分钟。" }],
      allPreviousMemoriesInvalidated: false
    }));
    await expect(pending).resolves.toMatchObject({ ok: true, status: "applied" });
    expect((await readMemorySourceEntries(config, "working")).map((entry) => entry.text))
      .toEqual(["我会让记忆处理等待最长十分钟。"]);
  });

  it("cancels one memory Provider response at the shared 10-minute boundary", async () => {
    vi.useFakeTimers();
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let capturedOptions: ProviderCompleteOptions | undefined;
    const complete = vi.fn((
      _systemPrompt: string,
      _messages: Array<{ content: string }>,
      options?: ProviderCompleteOptions
    ) => {
      capturedOptions = options;
      markStarted?.();
      return new Promise<string>(() => undefined);
    });
    const runtime = runtimeWithProvider(config, complete);
    const before = await readWorkingMemoryDocument(config);
    let settled = false;

    const pending = mergeConversation(runtime, "等待十分钟后仍无响应");
    await started;
    void pending.then(
      () => { settled = true; },
      () => { settled = true; }
    );
    await vi.advanceTimersByTimeAsync(AUXILIARY_MODEL_RESPONSE_TIMEOUT_MS - 1);

    expect(settled).toBe(false);
    expect(capturedOptions?.signal?.aborted).toBe(false);
    expect(complete).toHaveBeenCalledOnce();

    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await vi.advanceTimersByTimeAsync(1);
    await rejected;
    expect(capturedOptions?.signal?.aborted).toBe(true);
    expect(complete).toHaveBeenCalledOnce();
    expect((await readWorkingMemoryDocument(config)).revision).toBe(before.revision);
  });

  it("does not retry or commit an invalid memory Provider response", async () => {
    await appendMemoryFacts(config, "working", [{ fact: "必须保留的事实" }]);
    const before = await readWorkingMemoryDocument(config);
    const complete = vi.fn(async () => "{\"facts\":");
    const runtime = runtimeWithProvider(config, complete);

    await expect(mergeConversation(runtime, "这次返回无法解析"))
      .resolves.toMatchObject({ ok: false, status: "model_invalid" });

    expect(complete).toHaveBeenCalledOnce();
    expect((await readWorkingMemoryDocument(config)).revision).toBe(before.revision);
    expect((await readMemorySourceEntries(config, "working")).map((entry) => entry.text))
      .toEqual(["必须保留的事实"]);
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
      expect(systemPrompt).toContain("当前角色对一件事的主观叙述");
      expect(systemPrompt).toContain("整理时同时参考 fact 内部叙述的时间");
      expect(systemPrompt).toContain("消息顺序");
      expect(systemPrompt).toContain("新的综合工作记忆");
      expect(systemPrompt).toContain("联想只用于发现输入中已有的联系");
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

  it("keeps Dream entries outside ordinary working-memory consolidation", async () => {
    const [factual] = await appendMemoryFacts(config, "working", [{
      fact: "普通事实等待后续确认。",
      occurredAt: "2026-07-01T00:00:00.000Z"
    }]);
    const beforeDream = await readWorkingMemoryDocument(config);
    const dream = {
      ...beforeDream.items[0]!,
      id: "working_dream_2026_07_10",
      content: "梦见一座漂浮的车站。",
      sourceKind: "dream" as const,
      memoryKind: "dream",
      realityStatus: "imagined",
      factuality: "imagined",
      eventType: "dream",
      eventKey: "dream:2026-07-10",
      dreamRunId: "dream-run-2026-07-10",
      dreamDate: "2026-07-10",
      dreamReviewedAt: "2026-07-10T04:00:00.000+08:00",
      occurredAt: "2026-07-10T04:00:00.000+08:00",
      conversationId: "dream:test-agent",
      conversationScope: "dream",
      conversationTitle: "Dream 2026-07-10"
    };
    const seeded = await replaceWorkingMemoryDocument(
      config,
      beforeDream.revision,
      [...beforeDream.items, dream]
    );
    expect(seeded.status).toBe("updated");

    const complete = vi.fn(async (_systemPrompt: string, messages: Array<{ content: string }>) => {
      const payload = parsePromptPayload(messages[0]!.content) as {
        previousWorkingMemories: Array<{ id: string; fact: string }>;
      };
      expect(payload.previousWorkingMemories).toEqual([
        expect.objectContaining({ id: factual!.id, fact: "普通事实等待后续确认。" })
      ]);
      return JSON.stringify({
        facts: [{
          id: factual!.id,
          fact: "普通事实仍在等待后续确认。",
          occurredAt: "2026-07-01T00:00:00.000Z"
        }],
        allPreviousMemoriesInvalidated: false
      });
    });
    const runtime = runtimeWithProvider(config, complete);

    const result = await mergeConversation(runtime, "还没有新的确认结果");
    const after = await readWorkingMemoryDocument(config);

    expect(result).toMatchObject({ ok: true, beforeCount: 2, afterCount: 2 });
    expect(after.items).toEqual([
      expect.objectContaining({
        id: factual!.id,
        content: "普通事实仍在等待后续确认。"
      }),
      dream
    ]);
    expect(after.content.match(/【梦境｜做梦时间：/gu)).toHaveLength(1);
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
    let profileSignal: AbortSignal | undefined;
    let workingSignal: AbortSignal | undefined;
    vi.spyOn(runtime, "compressUserProfiles").mockImplementation(async (
      _record,
      _batch,
      _participants,
      signal
    ) => {
      profileSignal = signal;
      return [{
        fact: "我知道海边用户（QQ 10001）喜欢测试。",
        userIds: ["10001"],
        userName: "海边用户"
      }, {
        fact: "我喜欢摄影。",
        userIds: ["10001"],
        userName: "海边用户"
      }];
    });
    const workingMerge = vi.spyOn(runtime, "requestWorkingMemoryMerge").mockImplementation(async (
      _context,
      _memories,
      signal
    ) => {
      workingSignal = signal;
      return {
        facts: [{ fact: "工作记忆正文" }],
        allPreviousMemoriesInvalidated: false
      };
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
    expect(profileSignal).toBeDefined();
    expect(workingSignal).toBe(profileSignal);
    expect((await readMemorySourceEntries(config, "working")).map((entry) => entry.text)).toEqual([
      "工作记忆正文"
    ]);
    expect(await readMemorySourceEntries(config, "long_term")).toEqual([]);
    expect((await readMemorySourceEntries(config, "user_profile"))[0]?.text).toContain("我知道海边用户（QQ 10001）喜欢测试。");
    expect((await readMemorySourceEntries(config, "user_profile"))[0]?.text).toContain("我喜欢摄影。");
  });

  it("shares one 10-minute deadline across the profile and working-memory stages", async () => {
    vi.useFakeTimers();
    const runtime = runtimeWithProvider(config, vi.fn(async () => "unused"));
    const before = await readWorkingMemoryDocument(config);
    let profileStarted!: () => void;
    const profileStage = new Promise<void>((resolve) => {
      profileStarted = resolve;
    });
    let workingStarted!: () => void;
    const workingStage = new Promise<void>((resolve) => {
      workingStarted = resolve;
    });
    let profileSignal: AbortSignal | undefined;
    let workingSignal: AbortSignal | undefined;
    vi.spyOn(runtime, "compressUserProfiles").mockImplementation((
      _record,
      _batch,
      _participants,
      signal
    ) => {
      profileSignal = signal;
      profileStarted();
      return new Promise((resolve) => {
        setTimeout(() => resolve([]), 120_001);
      });
    });
    const workingMerge = vi.spyOn(runtime, "requestWorkingMemoryMerge").mockImplementation((
      _context,
      _memories,
      signal
    ) => {
      workingSignal = signal;
      workingStarted();
      return new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    });
    const pending = runtime.processMemoryClaim({
      conversation: {
        id: "group:30003",
        scope: "user_group",
        title: "测试群",
        userId: 10001,
        groupId: 30003
      },
      batchId: "shared-memory-budget",
      messageIds: ["message-budget"],
      messages: [{
        id: "message-budget",
        sequence: 1,
        role: "user",
        text: "两阶段共享十分钟预算",
        at: "2026-07-10T00:00:00.000Z",
        userId: 10001,
        senderName: "海边用户",
        imageCount: 0,
        quoteCount: 0
      }],
      attemptMessageCount: 1
    });
    await profileStage;
    let settled = false;
    const observed = pending.then(
      (value) => ({ value, error: undefined }),
      (error: unknown) => ({ value: undefined, error })
    ).finally(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(120_001);
    await workingStage;
    await vi.advanceTimersByTimeAsync(
      AUXILIARY_MODEL_RESPONSE_TIMEOUT_MS - 120_001 - 1
    );

    expect(settled).toBe(false);
    expect(profileSignal).toBeDefined();
    expect(workingSignal).toBe(profileSignal);
    expect(workingSignal?.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    const outcome = await observed;

    expect(outcome.error).toMatchObject({ name: "AbortError" });
    expect(workingSignal?.aborted).toBe(true);
    expect(workingMerge).toHaveBeenCalledOnce();
    expect((await readWorkingMemoryDocument(config)).revision).toBe(before.revision);
  });

  it("cancels an in-flight memory claim on runtime close without a late commit or wake timer", async () => {
    const runtime = runtimeWithProvider(config, vi.fn(async () => "unused"));
    const before = await readWorkingMemoryDocument(config);
    let started!: () => void;
    const profileStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    let releaseProfile!: (value: []) => void;
    let claimSignal: AbortSignal | undefined;
    vi.spyOn(runtime, "compressUserProfiles").mockImplementation((
      _record,
      _batch,
      _participants,
      signal
    ) => {
      claimSignal = signal;
      started();
      return new Promise<[]>((resolve) => {
        releaseProfile = resolve;
      });
    });
    const workingMerge = vi.spyOn(runtime, "requestWorkingMemoryMerge");
    const pending = runtime.processMemoryClaim({
      conversation: {
        id: "group:30003",
        scope: "user_group",
        title: "测试群",
        userId: 10001,
        groupId: 30003
      },
      batchId: "runtime-close-memory-claim",
      messageIds: ["message-close"],
      messages: [{
        id: "message-close",
        sequence: 1,
        role: "user",
        text: "关闭后不得写入记忆",
        at: "2026-07-10T00:00:00.000Z",
        userId: 10001,
        senderName: "海边用户",
        imageCount: 0,
        quoteCount: 0
      }],
      attemptMessageCount: 1
    });
    await profileStarted;

    runtime.close();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(claimSignal?.aborted).toBe(true);
    expect((runtime as unknown as { memoryWakeTimer?: NodeJS.Timeout }).memoryWakeTimer)
      .toBeUndefined();

    releaseProfile([]);
    await Promise.resolve();
    await Promise.resolve();
    expect(workingMerge).not.toHaveBeenCalled();
    expect((await readWorkingMemoryDocument(config)).revision).toBe(before.revision);
    expect((runtime as unknown as { memoryWakeTimer?: NodeJS.Timeout }).memoryWakeTimer)
      .toBeUndefined();
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
  complete: (
    systemPrompt: string,
    messages: Array<{ content: string }>,
    options?: ProviderCompleteOptions
  ) => Promise<string>
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
