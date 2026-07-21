// @vitest-environment node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applicationDataStore } from "../../adapters/sqlite/applicationDataStore.js";
import {
  appendMemoryFacts,
  applyMemoryBatchTransaction,
  isMemoryCausalChainKey,
  MEMORY_CAUSAL_CHAIN_KEY_MAX_LENGTH,
  readMemorySourceEntries,
  readWorkingMemorySnapshot,
  replaceWorkingMemoryFacts,
  upsertLongTermMemoryFacts
} from "../../services/memory/memoryService.js";
import type { AppConfig } from "../../src/types.js";
import { createAdminTestConfig } from "./admin-fixtures.js";

describe("memory causal chain key", () => {
  let rootDir = "";
  let config: AppConfig;

  beforeEach(async () => {
    rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-memory-causal-chain-"));
    config = createAdminTestConfig(rootDir);
  });

  afterEach(async () => {
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  it("accepts only bounded causal-prefixed keys", () => {
    const longestValid = `causal:${"a".repeat(MEMORY_CAUSAL_CHAIN_KEY_MAX_LENGTH - "causal:".length)}`;

    expect(isMemoryCausalChainKey("causal:a")).toBe(true);
    expect(isMemoryCausalChainKey("causal:release_2026.07-20")).toBe(true);
    expect(isMemoryCausalChainKey(longestValid)).toBe(true);
    expect(isMemoryCausalChainKey(`${longestValid}a`)).toBe(false);
    expect(isMemoryCausalChainKey("causal:Release")).toBe(false);
    expect(isMemoryCausalChainKey("causal:release/phase")).toBe(false);
    expect(isMemoryCausalChainKey(" causal:release")).toBe(false);
  });

  it("persists a valid key in working and long-term raw records without changing addressNames", async () => {
    const [working] = await appendMemoryFacts(config, "working", [{
      fact: "我和海边用户（QQ 10001）确认了发布计划。",
      userIds: ["10001"],
      addressNames: ["海边用户", "小海"],
      eventType: "decision",
      subjectKey: "发布计划",
      causalChainKey: "causal:release-plan"
    }]);
    const [longTerm] = await upsertLongTermMemoryFacts(config, [{
      fact: "发布计划会继续影响后续工作。",
      eventType: "decision",
      subjectKey: "发布计划",
      causalChainKey: "causal:release-plan"
    }]);

    expect(working).toMatchObject({
      causalChainKey: "causal:release-plan",
      addressNames: ["海边用户", "小海"]
    });
    expect(longTerm).toMatchObject({ causalChainKey: "causal:release-plan" });
    expect(applicationDataStore(config).readMemory("working")[0]).toMatchObject({
      causalChainKey: "causal:release-plan",
      addressNames: ["海边用户", "小海"]
    });
    expect(applicationDataStore(config).readMemory("working")[0]).not.toHaveProperty("addressName");
    expect(applicationDataStore(config).readMemory("long_term")[0]).toMatchObject({
      causalChainKey: "causal:release-plan"
    });
  });

  it("fails closed for a supplied invalid key", async () => {
    const invalidKeys = [
      "",
      "event:release",
      "causal:Release",
      "causal:release phase",
      `causal:${"a".repeat(122)}`
    ];

    for (const causalChainKey of invalidKeys) {
      await expect(appendMemoryFacts(config, "working", [{
        fact: `非法因果链 ${causalChainKey || "empty"}`,
        causalChainKey
      }])).resolves.toEqual([]);
    }

    expect(applicationDataStore(config).readMemory("working")).toEqual([]);

    const [original] = await appendMemoryFacts(config, "working", [{ fact: "必须保留的原工作记忆。" }]);
    const snapshot = await readWorkingMemorySnapshot(config);
    await expect(replaceWorkingMemoryFacts(config, [{
      fact: "带非法因果链的替换结果。",
      causalChainKey: "causal:invalid/path"
    }], {
      expectedSnapshotToken: snapshot.token
    })).resolves.toEqual({ status: "empty_not_authorized" });
    expect(applicationDataStore(config).readMemory("working")).toEqual([
      expect.objectContaining({ id: original!.id, fact: "必须保留的原工作记忆。" })
    ]);
  });

  it("does not expose an invalid key already present in a raw record", async () => {
    applicationDataStore(config).replaceMemory("working", [{
      id: "working_invalid_causal_key",
      fact: "原始记录仍可读取。",
      causalChainKey: "causal:invalid/path"
    }]);

    expect((await readMemorySourceEntries(config, "working"))[0]).toMatchObject({
      id: "working_invalid_causal_key",
      text: "原始记录仍可读取。",
      causalChainKey: undefined
    });
  });

  it("preserves one common key across working-to-long-term mapping", async () => {
    const snapshot = await readWorkingMemorySnapshot(config);
    const result = await applyMemoryBatchTransaction(config, {
      batchId: "causal-chain-batch",
      expectedWorkingSnapshotToken: snapshot.token,
      workingFacts: [{
        fact: "我和海边用户（QQ 10001）决定发布。",
        userIds: ["10001"],
        addressNames: ["海边用户"],
        eventType: "decision",
        subjectKey: "发布计划",
        causalChainKey: "causal:release-plan",
        promoteToLongTerm: true
      }],
      longTermFacts: [{
        fact: "我和海边用户（QQ 10001）的发布决定会影响后续安排。",
        userIds: ["10001"],
        addressNames: ["海边用户"],
        eventType: "decision",
        subjectKey: "发布计划",
        causalChainKey: "causal:release-plan"
      }],
      userProfileFacts: []
    });

    expect(result).toMatchObject({
      status: "applied",
      workingEntries: [expect.objectContaining({ causalChainKey: "causal:release-plan" })],
      longTermEntries: [expect.objectContaining({ causalChainKey: "causal:release-plan" })]
    });
    expect(applicationDataStore(config).readMemory("working")[0]).toMatchObject({
      causalChainKey: "causal:release-plan",
      longTermId: expect.any(String)
    });
  });

  it("keeps an existing key when an update omits it and drops conflicting keys", async () => {
    const [original] = await upsertLongTermMemoryFacts(config, [{
      fact: "发布计划已经启动。",
      eventType: "milestone",
      subjectKey: "发布计划",
      causalChainKey: "causal:release-plan"
    }]);

    await upsertLongTermMemoryFacts(config, [{
      fact: "发布计划已经进入验证阶段。",
      eventType: "milestone",
      subjectKey: "发布计划",
      longTermId: original!.id
    }]);
    expect((await readMemorySourceEntries(config, "long_term"))[0]).toMatchObject({
      causalChainKey: "causal:release-plan"
    });

    await upsertLongTermMemoryFacts(config, [{
      fact: "发布计划的因果归属出现冲突。",
      eventType: "milestone",
      subjectKey: "发布计划",
      longTermId: original!.id,
      causalChainKey: "causal:unrelated-plan"
    }]);
    expect((await readMemorySourceEntries(config, "long_term"))[0]?.causalChainKey).toBeUndefined();
    expect(applicationDataStore(config).readMemory("long_term")[0]).not.toHaveProperty("causalChainKey");
  });
});
