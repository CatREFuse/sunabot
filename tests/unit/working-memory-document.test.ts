// @vitest-environment node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  WORKING_MEMORY_FILE,
  WORKING_MEMORY_MAX_BYTES,
  appendWorkingMemoryDocumentItem,
  readWorkingMemoryDocument,
  replaceWorkingMemoryDocument,
  workingMemoryItemsFromFacts
} from "../../services/memory/public.js";
import type { AppConfig } from "../../src/types.js";
import { createAdminTestConfig } from "./admin-fixtures.js";

describe("working-memory Markdown document", () => {
  let root = "";
  let config: AppConfig;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-workmemory-doc-"));
    config = createAdminTestConfig(path.join(root, "agent-a"));
    await fs.mkdir(config.persona.agentWorkspace, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("isolates one document per Agent and records host time plus conversation provenance", async () => {
    const other = createAdminTestConfig(path.join(root, "agent-b"));
    await fs.mkdir(other.persona.agentWorkspace, { recursive: true });

    const first = await appendWorkingMemoryDocumentItem(config, "当前要继续验证记忆门禁。", {
      conversationId: "account:primary:group:30003",
      scope: "user_group",
      title: "测试群"
    });
    await appendWorkingMemoryDocumentItem(other, "另一个 Agent 的事项。", {
      conversationId: "private:10002",
      scope: "private",
      title: "另一会话"
    });

    expect(first.item.recordedAt).toMatch(/(?:Z|[+-]\d{2}:\d{2})$/);
    expect(first.item.timeZone).toBeTruthy();
    const snapshot = await readWorkingMemoryDocument(config);
    expect(snapshot.items).toEqual([
      expect.objectContaining({
        content: "当前要继续验证记忆门禁。",
        conversationId: "account:primary:group:30003",
        conversationScope: "user_group",
        conversationTitle: "测试群",
        sourceKind: "add_workmemory"
      })
    ]);
    expect(snapshot.content).toContain("当前要继续验证记忆门禁。");
    expect(snapshot.content).not.toContain("记录时间：");
    expect(snapshot.content).not.toContain("会话来源：");
    expect((await readWorkingMemoryDocument(other)).items[0]?.content).toBe("另一个 Agent 的事项。");
  });

  it("fails closed on stale revisions, symbolic links, and oversized files", async () => {
    const initial = await readWorkingMemoryDocument(config);
    await appendWorkingMemoryDocumentItem(config, "并发写入。", {
      conversationId: "private:10001",
      scope: "private"
    });
    const latest = await readWorkingMemoryDocument(config);
    await expect(replaceWorkingMemoryDocument(config, initial.revision, latest.items))
      .resolves.toMatchObject({ status: "conflict" });

    const filePath = path.join(config.persona.agentWorkspace, WORKING_MEMORY_FILE);
    const target = path.join(root, "outside.md");
    await fs.writeFile(target, "# outside\n");
    await fs.unlink(filePath);
    await fs.symlink(target, filePath);
    await expect(readWorkingMemoryDocument(config)).rejects.toMatchObject({
      code: "WORKING_MEMORY_PATH_INVALID"
    });

    await fs.unlink(filePath);
    await fs.writeFile(filePath, "x".repeat(WORKING_MEMORY_MAX_BYTES + 1));
    await expect(readWorkingMemoryDocument(config)).rejects.toMatchObject({
      code: "WORKING_MEMORY_TOO_LARGE"
    });
  });

  it("uses Unicode characters for the 4000-character item boundary", async () => {
    const content = "😀".repeat(4_000);
    await expect(appendWorkingMemoryDocumentItem(config, content, {
      conversationId: "private:10001",
      scope: "private"
    })).resolves.toMatchObject({
      item: { content }
    });

    await expect(appendWorkingMemoryDocumentItem(config, "😀".repeat(4_001), {
      conversationId: "private:10001",
      scope: "private"
    })).rejects.toMatchObject({
      code: "WORKING_MEMORY_ITEM_INVALID"
    });
  });

  it("rejects an Agent workspace that is itself a symbolic link", async () => {
    const target = path.join(root, "workspace-target");
    const linkedConfig = createAdminTestConfig(path.join(root, "linked-agent"));
    await fs.mkdir(target);
    await fs.mkdir(path.dirname(linkedConfig.persona.agentWorkspace), { recursive: true });
    await fs.symlink(target, linkedConfig.persona.agentWorkspace);

    await expect(readWorkingMemoryDocument(linkedConfig)).rejects.toMatchObject({
      code: "WORKING_MEMORY_PATH_INVALID"
    });
  });

  it("rejects damaged hidden provenance metadata", async () => {
    await appendWorkingMemoryDocumentItem(config, "保持旧文档。", {
      conversationId: "private:10001",
      scope: "private"
    });
    const filePath = path.join(config.persona.agentWorkspace, WORKING_MEMORY_FILE);
    const original = await fs.readFile(filePath, "utf8");
    await fs.writeFile(filePath, original.replace(/sunabot-workmemory:item [A-Za-z0-9_-]+/u,
      "sunabot-workmemory:item invalid-metadata"));
    await expect(readWorkingMemoryDocument(config)).rejects.toMatchObject({
      code: "WORKING_MEMORY_DOCUMENT_INVALID"
    });
  });

  it("accepts direct Markdown body edits while retaining host provenance metadata", async () => {
    await appendWorkingMemoryDocumentItem(config, "原事项。", {
      conversationId: "private:10001",
      scope: "private"
    });
    const filePath = path.join(config.persona.agentWorkspace, WORKING_MEMORY_FILE);
    const original = await fs.readFile(filePath, "utf8");
    await fs.writeFile(filePath, original.replace("原事项。", "人工修订后的事项。"));
    const edited = await readWorkingMemoryDocument(config);
    expect(edited.items[0]).toMatchObject({
      content: "人工修订后的事项。",
      conversationId: "private:10001",
      conversationScope: "private"
    });
  });

  it("keeps exact retained memory identity and provenance when the model omits metadata", async () => {
    await appendWorkingMemoryDocumentItem(config, "保留原事项。", {
      conversationId: "private:10001",
      scope: "private",
      title: "原会话",
      sourceDecisionKey: "event-retained-source-decision"
    });
    const current = await readWorkingMemoryDocument(config);
    const previous = [{
      ...current.items[0]!,
      userId: "10001",
      userIds: ["10001"],
      userName: "原用户",
      addressNames: ["原称呼"]
    }];
    const [retained] = workingMemoryItemsFromFacts(
      [{ id: previous[0]!.id, fact: previous[0]!.content }],
      previous,
      {
        conversationId: "group:20002",
        conversationScope: "user_group",
        conversationTitle: "新会话",
        batchId: "new-batch"
      },
      () => "unused"
    );

    expect(retained).toMatchObject({
      content: "保留原事项。",
      conversationId: "private:10001",
      conversationScope: "private",
      conversationTitle: "原会话",
      sourceDecisionKey: "event-retained-source-decision",
      userId: "10001",
      userIds: ["10001"],
      userName: "原用户",
      addressNames: ["原称呼"]
    });
  });

  it("round-trips Dream provenance needed by the next consolidation", async () => {
    await appendWorkingMemoryDocumentItem(config, "梦见旧车站漂在海面上。", {
      conversationId: "dream:agent-a",
      scope: "dream",
      title: "Dream 2026-07-24"
    }, "dream");
    const current = await readWorkingMemoryDocument(config);
    const replaced = await replaceWorkingMemoryDocument(config, current.revision, [{
      ...current.items[0]!,
      memoryKind: "dream",
      realityStatus: "imagined",
      factuality: "imagined",
      dreamRunId: "dream-run-1",
      dreamDate: "2026-07-24",
      dreamReviewedAt: "2026-07-24T04:00:00.000+08:00",
      sourceMemoryIds: ["working-a", "long-term-b"]
    }]);

    expect(replaced.current.items[0]).toMatchObject({
      sourceKind: "dream",
      memoryKind: "dream",
      factuality: "imagined",
      dreamDate: "2026-07-24",
      sourceMemoryIds: ["working-a", "long-term-b"]
    });
    expect(replaced.current.content).toContain("【梦境｜做梦时间：2026-07-24 04:00】\n梦见旧车站漂在海面上。");
    expect(replaced.current.items[0]?.content).toBe("梦见旧车站漂在海面上。");
  });

  it("does not label a factual item only because its write source is Dream", async () => {
    await appendWorkingMemoryDocumentItem(config, "普通工作记忆仍然是事实。", {
      conversationId: "dream:agent-a",
      scope: "dream",
      title: "Dream review"
    }, "dream");

    const current = await readWorkingMemoryDocument(config);

    expect(current.items[0]).toMatchObject({
      sourceKind: "dream",
      content: "普通工作记忆仍然是事实。"
    });
    expect(current.items[0]?.memoryKind).toBeFalsy();
    expect(current.content).not.toContain("【梦境｜做梦时间：");
  });
});
