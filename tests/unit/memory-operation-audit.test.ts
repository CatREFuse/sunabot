// @vitest-environment node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applicationDataStore,
  closeApplicationDataStores
} from "../../adapters/sqlite/applicationDataStore.js";
import {
  clearMemorySource,
  createMemoryEntry,
  deleteMemoryEntry,
  listMemoryOperationLogs,
  readMemoryProcessingHealth,
  recallMemory,
  recordMemoryOperation,
  updateMemoryEntry
} from "../../services/memory/public.js";
import type { AppConfig } from "../../src/types.js";
import { createAdminTestConfig } from "./admin-fixtures.js";

describe("memory operation audit", () => {
  let root = "";
  let config: AppConfig;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-memory-audit-"));
    config = createAdminTestConfig(path.join(root, "plana"));
    await fs.mkdir(config.persona.agentWorkspace, { recursive: true });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    closeApplicationDataStores();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("records CRUD, recall, and Dream outcomes without copying memory text", async () => {
    const created = await createMemoryEntry(config, {
      source: "long_term",
      text: "我会在下次交付前继续复核测试结果。"
    });
    await updateMemoryEntry(config, {
      source: "long_term",
      id: created.id,
      text: "我会在下次交付前继续复核测试和构建结果。"
    });
    await recallMemory(config, { source: "long_term", query: "构建结果" });
    await deleteMemoryEntry(config, { source: "long_term", id: created.id });
    await createMemoryEntry(config, {
      source: "user_profile",
      text: "老师（QQ 10001）重视可验证的结果。",
      userId: "10001"
    });
    await clearMemorySource(config, "user_profile");
    recordMemoryOperation(config, {
      source: "dream",
      operation: "consolidate",
      actor: "dream",
      outcome: "rejected",
      batchId: "dream-run-1",
      conversationId: "dream:plana",
      conversationScope: "dream",
      reasonCode: "model_output_invalid"
    });

    const audit = applicationDataStore(config).readRequestLogs({
      query: "memory.operation",
      limit: 50
    });
    expect(new Set(audit.map((entry) => entry.action))).toEqual(new Set([
      "long_term.create",
      "long_term.update",
      "long_term.recall",
      "long_term.delete",
      "user_profile.create",
      "user_profile.clear",
      "dream.consolidate"
    ]));
    expect(audit.every((entry) => entry.category === "memory.operation")).toBe(true);
    expect(JSON.stringify(audit)).not.toContain("我会在下次交付前");
    expect(JSON.stringify(audit)).not.toContain("重视可验证的结果");
  });

  it("keeps audit history isolated by Agent database", () => {
    const arona = {
      ...createAdminTestConfig(path.join(root, "agents", "arona")),
      persona: {
        ...createAdminTestConfig(path.join(root, "agents", "arona")).persona,
        defaultAgentId: "arona"
      }
    };
    recordMemoryOperation(config, {
      source: "working",
      operation: "append",
      actor: "model_tool",
      outcome: "applied",
      conversationId: "private:1"
    });
    recordMemoryOperation(arona, {
      source: "working",
      operation: "append",
      actor: "model_tool",
      outcome: "applied",
      conversationId: "private:2"
    });

    expect(applicationDataStore(config).readRequestLogs({
      query: "memory.operation",
      limit: 10
    })[0]?.metadata).toMatchObject({ agentId: "plana", conversationId: "private:1" });
    expect(applicationDataStore(arona).readRequestLogs({
      query: "memory.operation",
      limit: 10
    })[0]?.metadata).toMatchObject({ agentId: "arona", conversationId: "private:2" });
  });

  it("reads only memory operations with bounded newest-first pagination", () => {
    applicationDataStore(config).appendRequestLog({
      id: "unrelated-log",
      at: "2026-07-24T01:00:00.000Z",
      category: "model.response",
      action: "responses.complete"
    });
    for (let index = 1; index <= 3; index += 1) {
      recordMemoryOperation(config, {
        source: "working",
        operation: "append",
        actor: "model_tool",
        outcome: "applied",
        conversationId: `private:${index}`
      });
    }

    const first = listMemoryOperationLogs(config, { page: 1, pageSize: 2 });
    const second = listMemoryOperationLogs(config, { page: 2, pageSize: 2 });

    expect(first).toMatchObject({ page: 1, pageSize: 2, total: 3, pageCount: 2 });
    expect(first.logs).toHaveLength(2);
    expect(second.logs).toHaveLength(1);
    expect([...first.logs, ...second.logs].every((entry) => entry.category === "memory.operation")).toBe(true);
    expect([...first.logs, ...second.logs].map((entry) => entry.id)).not.toContain("unrelated-log");
  });

  it("counts only explicit compression attempts inside the exact 24-hour window", () => {
    const store = applicationDataStore(config);
    const appendAttempt = (
      id: string,
      at: string,
      outcome: "applied" | "failed" | "unchanged" | "rejected",
      action = "working.compression_attempt"
    ) => store.appendMemoryOperationLog({
      id,
      at,
      category: "memory.operation",
      action,
      response: { outcome }
    });
    appendAttempt("attempt-boundary-success", "2026-07-30T12:00:00.000Z", "applied");
    appendAttempt("attempt-failed", "2026-07-31T01:00:00.000Z", "failed");
    appendAttempt("attempt-success", "2026-07-31T11:59:59.000Z", "applied");
    appendAttempt("attempt-too-old", "2026-07-30T11:59:59.999Z", "applied");
    appendAttempt("attempt-future", "2026-07-31T12:00:00.001Z", "applied");
    appendAttempt("attempt-unchanged", "2026-07-31T09:00:00.000Z", "unchanged");
    appendAttempt("attempt-rejected", "2026-07-31T09:30:00.000Z", "rejected");
    appendAttempt("unrelated-memory-operation", "2026-07-31T10:00:00.000Z", "failed", "working.batch_validate");
    store.appendMemoryOperationLog({
      id: "attempt-malformed",
      at: "2026-07-31T10:30:00.000Z",
      category: "memory.operation",
      action: "working.compression_attempt",
      response: { outcome: { invalid: true } }
    });

    expect(readMemoryProcessingHealth(config, {
      measuredAt: new Date("2026-07-31T12:00:00.000Z"),
      pending: 17
    })).toEqual({
      windowHours: 24,
      windowStartedAt: "2026-07-30T12:00:00.000Z",
      measuredAt: "2026-07-31T12:00:00.000Z",
      successful: 2,
      attempted: 3,
      pending: 17
    });
  });

  it("rejects invalid processing-health boundaries", () => {
    expect(() => readMemoryProcessingHealth(config, { pending: -1 })).toThrow(
      "Memory processing pending count is invalid."
    );
    expect(() => readMemoryProcessingHealth(config, {
      pending: 0,
      measuredAt: new Date(Number.NaN)
    })).toThrow("Memory processing health time is invalid.");
  });

  it("does not roll back a successful memory mutation when audit append fails", async () => {
    const store = applicationDataStore(config);
    vi.spyOn(store, "appendMemoryOperationLog").mockImplementation(() => {
      throw new Error("audit unavailable");
    });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const created = await createMemoryEntry(config, {
      source: "long_term",
      text: "我会保留已经成功提交的记忆。"
    });

    expect(created.text).toBe("我会保留已经成功提交的记忆。");
    expect(store.readMemory("long_term")).toHaveLength(1);
    expect(consoleError).toHaveBeenCalledWith("[memory-audit] append failed", expect.objectContaining({
      source: "long_term",
      operation: "create",
      outcome: "applied"
    }));
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain("audit unavailable");
  });
});
