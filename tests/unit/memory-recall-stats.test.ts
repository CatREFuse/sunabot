// @vitest-environment node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applicationDataStore,
  sqliteMemoryPersistence
} from "../../adapters/sqlite/applicationDataStore.js";
import { parseFinalPromptTemplate, renderFinalPromptTemplate } from "../../services/agent/promptSystem.js";
import {
  formatMemoryMatchesForPrompt,
  readMemorySourceEntries,
  recallMemory,
  recordModelContextRecall
} from "../../services/memory/public.js";
import { configureMemoryPersistence } from "../../services/memory/persistence.js";
import type { AppConfig } from "../../src/types.js";
import { ModelContextMemoryRecall } from "../../src/runtime/memoryRecallExposure.js";
import { createAdminTestConfig } from "./admin-fixtures.js";

describe("long-term memory recall tracking", () => {
  let root = "";
  let config: AppConfig;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-memory-recall-"));
    config = createAdminTestConfig(root);
    await fs.mkdir(config.persona.agentWorkspace, { recursive: true });
    const store = applicationDataStore(config);
    store.replaceMemory("long_term", [{
      id: "long-term-lighthouse",
      fact: "在海边看见一座发光的灯塔",
      occurredAt: "2026-05-01T01:00:00.000Z"
    }]);
    store.replaceMemory("working", [{ id: "working-lighthouse", fact: "今天画了灯塔" }]);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("counts only actual model-context recall and deduplicates a record within one run", async () => {
    const store = applicationDataStore(config);

    await recallMemory(config, { query: "灯塔", source: "long_term" });
    expect(store.listRecallStats(["long-term-lighthouse"])[0]).toMatchObject({
      recallCount: 0,
      distinctRecallDays: 0,
      lastRecalledAt: null
    });

    const firstUsage = {
      kind: "model_context" as const,
      recallKey: "reply-run-1",
      localDate: "2026-07-20",
      recalledAt: new Date("2026-07-20T03:00:00.000Z")
    };
    recordModelContextRecall(config,
      (await recallMemory(config, { query: "灯塔", source: "long_term" })).matches,
      firstUsage);
    recordModelContextRecall(config,
      (await recallMemory(config, { query: "发光", source: "long_term" })).matches,
      firstUsage);
    expect(store.listRecallStats(["long-term-lighthouse"])[0]).toMatchObject({
      recallCount: 1,
      distinctRecallDays: 1,
      lastRecalledAt: "2026-07-20T03:00:00.000Z"
    });

    recordModelContextRecall(config,
      (await recallMemory(config, { query: "灯塔", source: "long_term" })).matches, {
      ...firstUsage,
      recallKey: "reply-run-2",
      recalledAt: new Date("2026-07-20T04:00:00.000Z")
    });
    recordModelContextRecall(config,
      (await recallMemory(config, { query: "灯塔", source: "long_term" })).matches, {
      ...firstUsage,
      recallKey: "reply-run-3",
      localDate: "2026-07-21",
      recalledAt: new Date("2026-07-21T04:00:00.000Z")
    });
    expect(store.listRecallStats(["long-term-lighthouse"])[0]).toMatchObject({
      recallCount: 3,
      distinctRecallDays: 2,
      lastRecallLocalDate: "2026-07-21"
    });
  });

  it("defers initial and tool recall receipts until the model turn succeeds", async () => {
    const store = applicationDataStore(config);
    const omittedPrompt = new ModelContextMemoryRecall(config, "omitted-prompt");
    const omittedMatches = (await omittedPrompt.search({ query: "灯塔", source: "long_term" })).matches;
    omittedPrompt.includePromptVariable(makeRenderedPrompt("没有记忆变量", {}), "memory.long_term", omittedMatches);
    omittedPrompt.commit();
    expect(store.listRecallStats(["long-term-lighthouse"])[0]?.recallCount).toBe(0);

    const failedTurn = new ModelContextMemoryRecall(config, "failed-turn");
    await failedTurn.recall({ query: "灯塔", source: "long_term" });
    expect(store.listRecallStats(["long-term-lighthouse"])[0]?.recallCount).toBe(0);

    const successfulTurn = new ModelContextMemoryRecall(config, "successful-turn");
    await successfulTurn.recall({ query: "灯塔", source: "long_term" });
    await successfulTurn.recall({ query: "发光", source: "long_term" });
    successfulTurn.commit();
    successfulTurn.commit();
    expect(store.listRecallStats(["long-term-lighthouse"])[0]?.recallCount).toBe(1);

    const renderedPrompt = new ModelContextMemoryRecall(config, "rendered-prompt");
    const initial = await renderedPrompt.search({ query: "灯塔", source: "long_term" });
    renderedPrompt.includePromptVariable(renderedPromptRequest(
      "memory.long_term",
      formatMemoryMatchesForPrompt(initial.matches)
    ), "memory.long_term", initial.matches);
    renderedPrompt.commit();
    expect(store.listRecallStats(["long-term-lighthouse"])[0]?.recallCount).toBe(2);

    const renderedRecord = new ModelContextMemoryRecall(config, "rendered-record");
    const related = await renderedRecord.search({ query: "灯塔", source: "long_term" });
    renderedRecord.includePromptVariable(renderedPromptRequest("memory.payload", {
      relatedLongTerm: related.matches.map((item) => ({ id: item.id, fact: item.text }))
    }), "memory.payload", related.matches);
    renderedRecord.commit();
    expect(store.listRecallStats(["long-term-lighthouse"])[0]?.recallCount).toBe(3);
  });

  it("fails closed before a stale prompt can expose a long-term memory removed after search", async () => {
    const store = applicationDataStore(config);
    const exposure = new ModelContextMemoryRecall(config, "stale-prompt");
    const matches = (await exposure.search({ query: "灯塔", source: "long_term" })).matches;
    store.replaceMemory("long_term", []);

    expect(() => exposure.includePromptVariable(
      renderedPromptRequest("memory.long_term", formatMemoryMatchesForPrompt(matches)),
      "memory.long_term",
      matches
    )).toThrow("Memory model-context exposure is stale");
    expect(store.listRecallStats(["long-term-lighthouse"])).toEqual([]);
  });

  it("filters a stale long-term tool result when its pending exposure cannot be registered", async () => {
    const store = applicationDataStore(config);
    configureMemoryPersistence({
      databasePath: () => store.databasePath,
      repository: () => new Proxy(store, {
        get(target, property) {
          if (property === "reserveActualRecall") {
            return () => ({ reserved: false, recordPresent: false });
          }
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        }
      })
    });
    try {
      const exposure = new ModelContextMemoryRecall(config, "stale-tool-result");
      const result = await exposure.recall({ query: "灯塔", source: "long_term" });

      expect(result).toMatchObject({ ok: true, matches: [] });
      exposure.commit();
      expect(store.listRecallStats(["long-term-lighthouse"])[0]).toMatchObject({ recallCount: 0 });
    } finally {
      configureMemoryPersistence(sqliteMemoryPersistence);
    }
  });

  it("exposes recall stats in long-term entries without counting working memory", async () => {
    recordModelContextRecall(config,
      (await recallMemory(config, { query: "灯塔", source: "working" })).matches, {
      kind: "model_context",
      recallKey: "reply-working",
      localDate: "2026-07-20"
    });

    const [entry] = await readMemorySourceEntries(config, "long_term");
    expect(entry).toMatchObject({
      id: "long-term-lighthouse",
      recallCount: 0,
      distinctRecallDays: 0
    });
    expect(entry.recallTrackingStartedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(applicationDataStore(config).listRecallStats(["working-lighthouse"])).toEqual([]);
  });

  it("marks dream memories as imagined when formatting model context", () => {
    expect(formatMemoryMatchesForPrompt([{
      id: "dream-1",
      source: "long_term",
      sourceTitle: "长期记忆",
      fileName: "LONG_TERM_MEMORY.jsonl",
      editable: true,
      key: "dream-1",
      value: "我在云上捡到一把钥匙",
      text: "我在云上捡到一把钥匙",
      field: "fact",
      eventType: "dream"
    }])).toBe("长期记忆（梦境，非现实经历）：我在云上捡到一把钥匙");
  });
});

function makeRenderedPrompt(
  content: string,
  variables: Parameters<typeof renderFinalPromptTemplate>[1]
) {
  return renderFinalPromptTemplate(parseFinalPromptTemplate(JSON.stringify({
    messages: [{ role: "system", content: "系统" }, { role: "user", content }],
    response_format: { type: "text" }
  })), variables);
}

function renderedPromptRequest(
  variable: string,
  value: Parameters<typeof renderFinalPromptTemplate>[1][string]
) {
  return makeRenderedPrompt(`@{${variable}}`, { [variable]: value });
}
