// @vitest-environment node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applicationDataStore } from "../../adapters/sqlite/applicationDataStore.js";
import {
  appendMemoryFacts,
  applyMemoryBatchTransaction,
  isMemoryBatchCommitted,
  listMemoryEntries,
  mergeUserProfileMemory,
  normalizeEventMemorySchema,
  readMemorySourceEntries,
  readStrictJsonlFile,
  readUserProfileForUser,
  readWorkingMemorySnapshot,
  recallMemory,
  recoverMemoryTransactions,
  resolveUserAddressName,
  updateMemoryEntry,
  upsertLongTermMemoryFacts
} from "../../services/memory/public.js";
import type { AppConfig } from "../../src/types.js";
import { loadPersona } from "../../services/agent/persona.js";
import { createAdminTestConfig } from "./admin-fixtures.js";

describe("memory v2 storage", () => {
  let rootDir = "";
  let workspace = "";
  let config: AppConfig;

  beforeEach(async () => {
    rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-memory-v2-"));
    config = createAdminTestConfig(rootDir);
    workspace = config.persona.agentWorkspace;
    await fs.mkdir(workspace, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  it("only exposes active sources and rejects removed sources", async () => {
    const payload = await listMemoryEntries(config);
    expect(payload.sources.map((source) => source.id)).toEqual(["working", "long_term", "user_profile"]);
    await expect(listMemoryEntries(config, "dream")).rejects.toMatchObject({ code: "MEMORY_SOURCE_INVALID" });
    await expect(recallMemory(config, { query: "梦", source: "candidates" })).rejects.toMatchObject({
      code: "MEMORY_SOURCE_INVALID"
    });
  });

  it("returns the complete working-memory Markdown document for the admin view", async () => {
    await appendMemoryFacts(config, "working", [{ fact: "整份工作记忆正文" }]);

    const payload = await listMemoryEntries(config, "working");

    expect(payload.document).toMatchObject({
      fileName: "WORKING_MEMORY.md",
      revision: expect.any(String)
    });
    expect(payload.document?.content).toContain("<!-- sunabot-workmemory:v2 -->");
    expect(payload.document?.content).toContain("整份工作记忆正文");
    expect(payload.document?.content).not.toContain("记录时间：");
    expect(payload.entries).toHaveLength(1);
  });

  it("does not load removed diary, dream, or candidate files into the persona", async () => {
    await Promise.all([
      fs.writeFile(path.join(workspace, "WORKING_MEMORY.jsonl"), `${JSON.stringify({ fact: "工作事实" })}\n`),
      fs.writeFile(path.join(workspace, "LONG_TERM_MEMORY.jsonl"), `${JSON.stringify({ fact: "长期事实" })}\n`),
      fs.writeFile(path.join(workspace, "USER_PROFILE.jsonl"), `${JSON.stringify({ fact: "画像事实" })}\n`),
      fs.writeFile(path.join(workspace, "MEMORY_CANDIDATES.jsonl"), `${JSON.stringify({ fact: "候选事实" })}\n`),
      fs.writeFile(path.join(workspace, "DIARY.jsonl"), `${JSON.stringify({ diary: "日记事实" })}\n`),
      fs.writeFile(path.join(workspace, "DREAM.jsonl"), `${JSON.stringify({ dream: "梦境事实" })}\n`)
    ]);

    const persona = await loadPersona(config);
    expect(persona.memoryItems).toEqual(["工作事实", "画像事实", "长期事实"]);
    expect(persona.memoryItems.join("\n")).not.toMatch(/候选|日记|梦境/);
  });

  it("reports every active memory record without the retired persona cap", async () => {
    const records = (prefix: string) => Array.from({ length: 40 }, (_, index) => (
      JSON.stringify({ fact: `${prefix}-${index}` })
    )).join("\n") + "\n";
    await Promise.all([
      fs.writeFile(path.join(workspace, "WORKING_MEMORY.jsonl"), records("working")),
      fs.writeFile(path.join(workspace, "LONG_TERM_MEMORY.jsonl"), records("long-term")),
      fs.writeFile(path.join(workspace, "USER_PROFILE.jsonl"), records("profile"))
    ]);

    const persona = await loadPersona(config);

    expect(persona.memoryItems).toHaveLength(120);
  });

  it("normalizes salutation aliases and lets the user profile override the configured admin fallback", async () => {
    await fs.writeFile(path.join(workspace, "USER_PROFILE.jsonl"), [
      JSON.stringify({
        id: "profile-admin",
        userId: "171419991",
        fact: "管理员画像",
        salutation: "错误称呼",
        createdAt: "2026-07-01T00:00:00.000Z"
      }),
      JSON.stringify({
        id: "profile-user",
        userId: "703084445",
        fact: "喜欢绘画",
        address_name: "圆圆",
        createdAt: "2026-07-01T00:00:00.000Z"
      })
    ].join("\n") + "\n");

    await appendMemoryFacts(config, "user_profile", [{
      fact: "喜欢明亮色彩",
      userId: "703084445",
      userName: "新昵称",
      addressNames: ["模型新称呼", "圆圆"]
    }]);
    await mergeUserProfileMemory(config);

    expect(await readUserProfileForUser(config, "171419991")).toMatchObject({
      addressNames: ["Test Admin", "错误称呼"],
      addressName: "Test Admin"
    });
    const user = await readUserProfileForUser(config, "703084445");
    expect(user).toMatchObject({
      addressNames: ["圆圆", "模型新称呼"],
      addressName: "圆圆",
      userName: "新昵称"
    });
    expect(resolveUserAddressName(config, "703084445", user, "临时昵称")).toBe("圆圆");
    expect(resolveUserAddressName(config, "171419991", undefined, "临时昵称")).toBe("Test Admin");

    const admin = await readUserProfileForUser(config, "171419991");
    await updateMemoryEntry(config, {
      source: "user_profile",
      id: admin!.id,
      text: admin!.text,
      addressNames: ["管理台管理员称呼", "Test Admin"]
    });
    expect(await readUserProfileForUser(config, "171419991")).toMatchObject({
      addressNames: ["Test Admin", "管理台管理员称呼"]
    });

    await updateMemoryEntry(config, {
      source: "user_profile",
      id: user!.id,
      text: user!.text,
      addressNames: ["管理台称呼", "圆圆"]
    });
    expect(await readUserProfileForUser(config, "703084445")).toMatchObject({
      addressNames: ["管理台称呼", "圆圆"]
    });
    expect((await recallMemory(config, { query: "管理台称呼", source: "user_profile" })).matches[0]).toMatchObject({
      userId: "703084445",
      addressNames: ["管理台称呼", "圆圆"]
    });
  });

  it("writes working-memory event time into Markdown while keeping recorded time host-authoritative", async () => {
    const [range, legacy] = await appendMemoryFacts(config, "working", [
      {
        fact: "完成部署",
        time: "2026-07-10T01:00:00.000Z/2026-07-10T02:00:00.000Z",
        observedAt: "2026-07-10T02:01:00.000Z",
        userIds: ["171419991"],
        sourceWorkingMemoryIds: ["working-source-1"],
        eventType: "task",
        subjectKey: "sunabot:deploy",
        promoteToLongTerm: true
      },
      { fact: "旧时间文本", time: "昨天下午" }
    ]);
    const raw = applicationDataStore(config).readMemory("working");

    expect(range).toMatchObject({
      occurredAt: "2026-07-10T01:00:00.000Z",
      occurredEndAt: "2026-07-10T02:00:00.000Z",
      recordedAt: expect.stringMatching(/(?:Z|[+-]\d{2}:\d{2})$/),
      conversationId: "system:memory",
      conversationScope: "system"
    });
    expect(range!.observedAt).toBe(range!.recordedAt);
    expect(legacy).toMatchObject({ text: "旧时间文本" });
    expect(raw).toEqual([]);
    const document = await fs.readFile(path.join(workspace, "WORKING_MEMORY.md"), "utf8");
    expect(document).toContain("完成部署");
    expect(document).not.toContain("记录时间：");
  });

  it("leaves legacy SQLite working rows untouched while normalizing long-term records", async () => {
    await Promise.all([
      fs.writeFile(path.join(workspace, "WORKING_MEMORY.jsonl"), `${JSON.stringify({
        id: "working-legacy",
        fact: "旧工作事件",
        time: "昨天下午"
      })}\n`),
      fs.writeFile(path.join(workspace, "LONG_TERM_MEMORY.jsonl"), `${JSON.stringify({
        id: "long-term-partial",
        fact: "长期事件",
        occurredAt: "2026-07-10T01:00:00.000Z"
      })}\n`)
    ]);

    await expect(normalizeEventMemorySchema(config)).resolves.toEqual({ updated: 1 });
    const working = applicationDataStore(config).readMemory("working");
    const [longTerm] = applicationDataStore(config).readMemory("long_term");

    expect(working).toEqual([]);
    expect(await fs.readFile(path.join(workspace, "WORKING_MEMORY.jsonl"), "utf8"))
      .toContain("\"time\":\"昨天下午\"");
    expect(longTerm).toMatchObject({
      schemaVersion: 2,
      occurredAt: "2026-07-10T01:00:00.000Z",
      occurredEndAt: null,
      observedAt: null
    });
  });

  it("deterministically updates the same long-term event and unions source ids", async () => {
    const [created] = await upsertLongTermMemoryFacts(config, [{
      fact: "开始整理普拉娜记忆",
      occurredAt: "2026-07-10T01:00:00.000Z",
      userIds: ["171419991"],
      eventType: "task",
      subjectKey: "sunabot:plana-memory",
      sourceWorkingMemoryIds: ["working-1"]
    }]);
    const [updated] = await upsertLongTermMemoryFacts(config, [{
      fact: "普拉娜记忆整理完成",
      occurredAt: "2026-07-10T01:00:00.000Z",
      occurredEndAt: "2026-07-10T03:00:00.000Z",
      userIds: ["171419991"],
      eventType: "task",
      subjectKey: "sunabot:plana-memory",
      sourceWorkingMemoryIds: ["working-2"],
      longTermId: "invented-id"
    }]);

    expect(updated!.id).toBe(created!.id);
    expect(updated).toMatchObject({
      text: "普拉娜记忆整理完成",
      occurredEndAt: "2026-07-10T03:00:00.000Z",
      sourceWorkingMemoryIds: ["working-1", "working-2"]
    });
    expect(await readMemorySourceEntries(config, "long_term")).toHaveLength(1);
  });

  it("rejects malformed JSONL and duplicate ids instead of dropping lines", async () => {
    const filePath = path.join(workspace, "STRICT.jsonl");
    await fs.writeFile(filePath, "{bad json}\n");
    await expect(readStrictJsonlFile(filePath)).rejects.toThrow(/STRICT\.jsonl:1/);
    await fs.writeFile(filePath, `${JSON.stringify({ id: "same" })}\n${JSON.stringify({ id: "same" })}\n`);
    await expect(readStrictJsonlFile(filePath)).rejects.toThrow(/Duplicate JSONL id same/);
  });

  it("commits the Markdown working document and SQLite profile as one replayable scheduler batch", async () => {
    const [working] = await appendMemoryFacts(config, "working", [{ fact: "旧工作事实" }]);
    const snapshot = await readWorkingMemorySnapshot(config);
    const input = {
      batchId: "batch-1",
      expectedWorkingSnapshotToken: snapshot.token,
      workingFacts: [{
        id: working!.id,
        fact: "新工作事实",
        occurredAt: "2026-07-10T01:00:00.000Z",
        eventType: "task",
        subjectKey: "memory:batch-1",
        promoteToLongTerm: true
      }],
      userProfileFacts: [{
        fact: "我知道圆圆（QQ 703084445）喜欢测试。",
        time: "2026-07-10 09:00 至 2026-07-10 10:00",
        userId: "703084445",
        addressNames: ["圆圆"]
      }],
      longTermFacts: [],
      metadata: {
        replaceUserProfileFacts: true,
        conversationId: "group:batch-test",
        conversationScope: "user_group",
        conversationTitle: "批次测试群"
      }
    };
    expect(await isMemoryBatchCommitted(config, input.batchId)).toBe(false);
    const applied = await applyMemoryBatchTransaction(config, input);
    expect(await isMemoryBatchCommitted(config, input.batchId)).toBe(true);
    const replayed = await applyMemoryBatchTransaction(config, input);

    expect(applied).toMatchObject({ status: "applied", transactionId: expect.any(String) });
    expect(replayed).toMatchObject({ status: "applied", transactionId: (applied as { transactionId: string }).transactionId });
    expect((await readMemorySourceEntries(config, "working"))[0]).toMatchObject({
      text: "新工作事实",
      conversationId: "system:memory",
      conversationScope: "system",
      sourceKind: "model_merge"
    });
    const profile = await readUserProfileForUser(config, "703084445");
    expect(profile).toMatchObject({ addressNames: ["圆圆"] });
    expect(Number.isFinite(Date.parse(profile!.createdAt!))).toBe(true);
    expect(await readMemorySourceEntries(config, "long_term")).toHaveLength(0);
    expect(applicationDataStore(config).hasMemoryBatch(input.batchId)).toBe(true);
  });

  it("does not need file-journal recovery after SQLite transactions", async () => {
    await appendMemoryFacts(config, "working", [{ fact: "事务内工作记忆" }]);
    await expect(recoverMemoryTransactions(config)).resolves.toEqual({ recovered: 0 });
    expect(await readMemorySourceEntries(config, "working")).toEqual([
      expect.objectContaining({ text: "事务内工作记忆" })
    ]);
  });
});
