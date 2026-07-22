// @vitest-environment node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applicationDataStore,
  closeApplicationDataStores
} from "../../adapters/sqlite/applicationDataStore.js";
import { SunaRuntime } from "../../src/runtime.js";
import type { ConversationMessageRecord, ConversationRecord } from "../../src/types.js";
import type { MemoryQueuedMessage } from "../../services/memory/public.js";
import { createAdminTestConfig } from "./admin-fixtures.js";

const temporaryDirectories: string[] = [];
const runtimes: SunaRuntime[] = [];

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) runtime.close();
  closeApplicationDataStores();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    fs.rm(directory, { recursive: true, force: true })
  )));
});

describe("runtime group memory selection", () => {
  it("uses only visible successful assistant replies as group anchors", async () => {
    const runtime = await createRuntime();
    const record = groupConversation([
      ...Array.from({ length: 25 }, (_, index) => message(index + 1, "user")),
      { ...message(26, "assistant"), visibility: "internal" },
      { ...message(27, "assistant"), eventKind: "orchestrator_decision", visibility: "internal" },
      { ...message(28, "assistant"), requestStatus: "running" },
      { ...message(29, "assistant"), requestStatus: "failed" },
      { ...message(30, "assistant"), text: "   " },
      message(31, "assistant"),
      ...Array.from({ length: 25 }, (_, index) => message(index + 32, "user"))
    ]);

    await runtime.enqueueConversationMemory(record);

    const state = (await runtime.memoryScheduler.snapshot()).conversations[record.id];
    expect(state?.pendingMessages.map((item) => item.sequence)).toEqual([
      ...Array.from({ length: 20 }, (_, index) => index + 6),
      31,
      ...Array.from({ length: 20 }, (_, index) => index + 32)
    ]);

    await runtime.enqueueConversationMemory(record);
    const repeated = (await runtime.memoryScheduler.snapshot()).conversations[record.id];
    expect(repeated?.pendingMessages).toEqual(state?.pendingMessages);
    expect(repeated?.unattemptedMessageCount).toBe(41);
  });

  it("does not enter memory processing with forty-seven selected group messages", async () => {
    const runtime = await createRuntime();
    const record = groupConversation(Array.from(
      { length: 48 },
      (_, index) => message(
        index + 1,
        index === 21 || index === 27 ? "assistant" : "user"
      )
    ));
    const processMemoryClaim = vi.fn(async () => true);
    (runtime as unknown as { processMemoryClaim: typeof processMemoryClaim }).processMemoryClaim = processMemoryClaim;
    await runtime.enqueueConversationMemory(record);

    await runtime.drainMemoryScheduler();

    expect(processMemoryClaim).not.toHaveBeenCalled();
    const state = (await runtime.memoryScheduler.snapshot()).conversations[record.id];
    expect(state?.currentBatch).toBeUndefined();
    expect(state?.unattemptedMessageCount).toBe(47);
  });

  it("settles a committed legacy group batch without calling memory processing", async () => {
    const runtime = await createRuntime();
    const record = groupConversation(Array.from(
      { length: 43 },
      (_, index) => message(index + 1, index === 21 ? "assistant" : "user")
    ));
    const pendingMessages = record.messages.map(toQueuedMessage);
    const batchId = "runtime-legacy-committed";
    applicationDataStore(runtime.config).replaceMemoryScheduler({
      [record.id]: {
        conversation: {
          id: record.id,
          scope: record.scope,
          title: record.title,
          userId: record.userId,
          groupId: record.groupId
        },
        state: "queued",
        pendingMessages,
        currentBatch: {
          batchId,
          messageIds: pendingMessages.map((item) => `${item.sequence}:${item.id}`),
          startedAt: "2026-07-18T00:00:00.000Z"
        },
        dirty: true,
        failureCount: 1,
        unattemptedMessageCount: 0,
        lastCommittedSequence: 0,
        updatedAt: "2026-07-18T00:00:00.000Z"
      }
    });
    const memoryStore = applicationDataStore(runtime.config);
    expect(memoryStore.commitMemoryBatch({
      batchId,
      baselineRevisions: memoryStore.readMemorySnapshot().revisions,
      working: [],
      longTerm: [],
      userProfile: [],
      result: { status: "applied" }
    }).status).toBe("committed");
    runtime.conversationRecords.set(record.id, record);
    const processMemoryClaim = vi.fn(async () => true);
    (runtime as unknown as { processMemoryClaim: typeof processMemoryClaim }).processMemoryClaim = processMemoryClaim;

    await runtime.memoryScheduler.initialize();
    await runtime.enqueueConversationMemory(record);
    await runtime.drainMemoryScheduler();

    expect(processMemoryClaim).not.toHaveBeenCalled();
    expect((await runtime.memoryScheduler.snapshot()).conversations[record.id]?.pendingMessages).toEqual([]);
    expect(record.memoryCompressedThroughMessageCount).toBe(43);
  });
});

async function createRuntime() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-runtime-memory-selection-"));
  temporaryDirectories.push(root);
  const runtime = new SunaRuntime(createAdminTestConfig(root), { attachmentService: {} as never });
  runtimes.push(runtime);
  return runtime;
}

function groupConversation(messages: ConversationMessageRecord[]): ConversationRecord {
  return {
    id: "group:3003",
    scope: "user_group",
    title: "测试群",
    userId: 171419991,
    groupId: 3003,
    replyEnabled: true,
    messageCount: messages.length,
    lastAt: messages.at(-1)?.at ?? "2026-07-18T00:00:00.000Z",
    lastText: messages.at(-1)?.text ?? "",
    messages
  };
}

function message(sequence: number, role: ConversationMessageRecord["role"]): ConversationMessageRecord {
  return {
    id: `message-${sequence}`,
    sequence,
    role,
    text: `消息 ${sequence}`,
    at: new Date(Date.UTC(2026, 6, 18, 0, 0, sequence)).toISOString(),
    userId: 171419991,
    groupId: 3003,
    senderName: role === "assistant" ? "普拉娜" : "测试用户"
  };
}

function toQueuedMessage(message: ConversationMessageRecord): MemoryQueuedMessage {
  return {
    id: message.id,
    sequence: message.sequence!,
    role: message.role as "user" | "assistant",
    text: message.text,
    at: message.at,
    userId: message.userId,
    senderName: message.senderName,
    imageCount: message.imageUrls?.length ?? 0,
    quoteCount: message.quoteReferences?.length ?? 0
  };
}
