import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { applicationDataStore, closeApplicationDataStores } from "../../adapters/sqlite/applicationDataStore.js";
import { appendRequestLog, readModelCallStats, readRequestLogPage, readTokenUsageSummary } from "../../src/requestLog.js";

afterEach(() => {
  vi.useRealTimers();
  closeApplicationDataStores();
});

describe("request log token usage", () => {
  it("aggregates model calls by behavior and exact conversation", async () => {
    const conversationId = `group:${randomUUID()}`;
    const append = (stage: string, memoryKind?: "working" | "long_term" | "user_profile") => appendRequestLog({
      category: "model.response",
      action: "responses.complete",
      response: { usage: { input_tokens: 8, output_tokens: 2, total_tokens: 10 } },
      metadata: { conversationId, stage, ...(memoryKind ? { memoryKind } : {}) }
    });

    await append("reply");
    await append("orchestrator");
    await append("memory", "working");
    await append("memory", "long_term");
    await append("memory", "user_profile");
    await appendRequestLog({
      category: "model.response",
      action: "responses.complete",
      response: { usage: { input_tokens: 80, output_tokens: 20, total_tokens: 100 } },
      metadata: { conversationId: "group:other", stage: "reply" }
    });

    expect(readModelCallStats({ conversationId })).toMatchObject({
      total: { requests: 5, total: 50 },
      behavior: {
        reply: { requests: 1, total: 10 },
        orchestrator: { requests: 1, total: 10 },
        memory: { requests: 3, total: 30 },
        other: { requests: 0, total: 0 }
      },
      memory: {
        total: { requests: 3, total: 30 },
        kinds: {
          working: { requests: 1, total: 10 },
          long_term: { requests: 1, total: 10 },
          user_profile: { requests: 1, total: 10 }
        }
      }
    });
  });

  it("aggregates Responses, Chat Completions and Gemini usage", async () => {
    await appendRequestLog({
      category: "model.response",
      action: "responses.complete",
      response: { summary: { usage: { input_tokens: 120, output_tokens: 30, total_tokens: 150 } } }
    });
    await appendRequestLog({
      category: "model.response",
      action: "chat.completions.complete",
      response: { usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } }
    });
    await appendRequestLog({
      category: "model.response",
      action: "gemini.generate-content",
      response: { usage: { promptTokenCount: 40, candidatesTokenCount: 15, thoughtsTokenCount: 5, totalTokenCount: 60 } }
    });

    expect(readTokenUsageSummary(new Date().getTimezoneOffset()).today).toMatchObject({
      input: 180,
      output: 60,
      total: 240,
      cachedInput: 0,
      cacheRate: null,
      requests: 3
    });
  });

  it("normalizes cached input across provider protocols without double counting", async () => {
    await appendRequestLog({
      category: "model.response",
      action: "responses.complete",
      providerKind: "openai-official",
      response: {
        summary: {
          usage: {
            input_tokens: 100,
            input_tokens_details: { cached_tokens: 60, cache_write_tokens: 20 },
            output_tokens: 20,
            total_tokens: 120
          }
        }
      }
    });
    await appendRequestLog({
      category: "model.response",
      action: "chat.completions.complete",
      providerKind: "openai-compatible",
      response: {
        usage: {
          prompt_tokens: 50,
          prompt_tokens_details: { cached_tokens: 10 },
          completion_tokens: 5,
          total_tokens: 55
        }
      }
    });
    await appendRequestLog({
      category: "model.response",
      action: "anthropic.messages.complete",
      providerKind: "anthropic-official",
      response: {
        usage: {
          input_tokens: 10,
          cache_creation_input_tokens: 20,
          cache_read_input_tokens: 70,
          output_tokens: 5,
          total_tokens: 9_999
        }
      }
    });
    await appendRequestLog({
      category: "model.response",
      action: "gemini.generate-content.complete",
      providerKind: "gemini-official",
      response: {
        usage: {
          promptTokenCount: 80,
          toolUsePromptTokenCount: 20,
          cachedContentTokenCount: 50,
          candidatesTokenCount: 10,
          thoughtsTokenCount: 5,
          totalTokenCount: 115
        }
      }
    });

    expect(readTokenUsageSummary(new Date().getTimezoneOffset()).today).toMatchObject({
      input: 350,
      output: 45,
      total: 395,
      cachedInput: 190,
      cacheRate: 190 / 350,
      requests: 4
    });
  });

  it("weights cache rate only by requests that report cache usage", async () => {
    await appendRequestLog({
      category: "model.response",
      action: "responses.complete",
      response: {
        summary: {
          usage: {
            input_tokens: 100,
            input_tokens_details: { cached_tokens: 50 },
            output_tokens: 10,
            total_tokens: 110
          }
        }
      }
    });
    await appendRequestLog({
      category: "model.response",
      action: "responses.complete",
      response: { summary: { usage: { input_tokens: 900, output_tokens: 10, total_tokens: 910 } } }
    });

    expect(readTokenUsageSummary(new Date().getTimezoneOffset()).today).toMatchObject({
      input: 1_000,
      cachedInput: 50,
      cacheRate: 0.5,
      requests: 2
    });
  });

  it("does not infer non-Anthropic input from an orphaned cache field", async () => {
    await appendRequestLog({
      category: "model.response",
      action: "responses.complete",
      response: {
        summary: {
          usage: {
            input_tokens_details: { cached_tokens: 50 },
            output_tokens: 10
          }
        }
      }
    });

    const page = await readRequestLogPage({ page: 1, pageSize: 10 });
    expect(page.logs[0]).toMatchObject({
      tokenUsage: {
        input: 0,
        output: 10,
        total: 10,
        cachedInput: 0,
        cacheRate: 0
      }
    });
  });

  it("returns zero cache rate for an explicit zero-token cache report", async () => {
    await appendRequestLog({
      category: "model.response",
      action: "responses.complete",
      response: {
        summary: {
          usage: {
            input_tokens: 0,
            input_tokens_details: { cached_tokens: 0 },
            output_tokens: 0,
            total_tokens: 0
          }
        }
      }
    });

    expect(readTokenUsageSummary(new Date().getTimezoneOffset()).today).toMatchObject({
      input: 0,
      output: 0,
      total: 0,
      cachedInput: 0,
      cacheRate: 0,
      requests: 1
    });
  });

  it("groups day and hour buckets using the browser timezone offset", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-12T16:30:00.000Z"));
    const store = applicationDataStore();
    const appendAt = (at: string, input: number) => store.appendRequestLog({
      id: randomUUID(),
      at,
      category: "model.response",
      action: "responses.complete",
      response: {
        summary: {
          usage: {
            input_tokens: input,
            input_tokens_details: { cached_tokens: input / 2 },
            output_tokens: 1,
            total_tokens: input + 1
          }
        }
      }
    });

    appendAt("2026-07-12T15:59:00.000Z", 10);
    appendAt("2026-07-12T16:00:00.000Z", 20);

    const summary = readTokenUsageSummary(-480);
    expect(summary.today).toMatchObject({
      date: "2026-07-13",
      input: 20,
      cachedInput: 10,
      cacheRate: 0.5,
      requests: 1
    });
    expect(summary.hours).toHaveLength(24);
    expect(summary.hours[0]).toMatchObject({ hour: 0, input: 20, requests: 1 });
    expect(summary.hours[23]).toMatchObject({ hour: 23, input: 0, requests: 0 });
    expect(summary.days.find((day) => day.date === "2026-07-12")).toMatchObject({
      input: 10,
      cachedInput: 5,
      cacheRate: 0.5,
      requests: 1
    });
  });

  it("keeps extreme and invalid provider counts finite", async () => {
    for (let index = 0; index < 2; index += 1) {
      await appendRequestLog({
        category: "model.response",
        action: "anthropic.messages.complete",
        providerKind: "anthropic-compatible",
        response: {
          usage: {
            input_tokens: 1e308,
            cache_creation_input_tokens: 1e308,
            cache_read_input_tokens: 1e308,
            output_tokens: index === 0 ? 1e308 : -10,
            total_tokens: "Infinity"
          }
        }
      });
    }

    const summary = readTokenUsageSummary(new Date().getTimezoneOffset());
    for (const value of [
      summary.today.input,
      summary.today.output,
      summary.today.total,
      summary.today.cachedInput,
      summary.today.cacheRate
    ]) {
      expect(value).not.toBeNull();
      expect(Number.isFinite(value)).toBe(true);
    }
    expect(summary.today).toMatchObject({
      input: Number.MAX_SAFE_INTEGER,
      output: Number.MAX_SAFE_INTEGER,
      total: Number.MAX_SAFE_INTEGER,
      cachedInput: Number.MAX_SAFE_INTEGER,
      cacheRate: 1,
      requests: 2
    });
  });

  it("saturates legacy top-level token usage while deriving totals", async () => {
    applicationDataStore().appendRequestLog({
      id: randomUUID(),
      at: new Date().toISOString(),
      category: "model.response",
      action: "legacy.complete",
      tokenUsage: {
        input: 1e308,
        output: 1e308,
        total: 0,
        cachedInput: 1e308,
        cacheRate: 1
      }
    });

    const page = await readRequestLogPage({ page: 1, pageSize: 10 });
    expect(page.logs[0]).toMatchObject({
      tokenUsage: {
        input: Number.MAX_SAFE_INTEGER,
        output: Number.MAX_SAFE_INTEGER,
        total: Number.MAX_SAFE_INTEGER,
        cachedInput: Number.MAX_SAFE_INTEGER,
        cacheRate: 1
      }
    });
  });

  it("derives normalized token usage when reading legacy request logs", async () => {
    applicationDataStore().appendRequestLog({
      id: randomUUID(),
      at: new Date().toISOString(),
      category: "model.response",
      action: "codex.complete",
      providerKind: "codex-responses",
      response: {
        summary: {
          usage: {
            input_tokens: 200,
            input_tokens_details: { cached_tokens: 150, cache_write_tokens: 10 },
            output_tokens: 25,
            total_tokens: 225
          }
        }
      }
    });

    const page = await readRequestLogPage({ page: 1, pageSize: 10 });
    expect(page.logs[0]).toMatchObject({
      tokenUsage: {
        input: 200,
        output: 25,
        total: 225,
        cachedInput: 150,
        cacheRate: 0.75
      }
    });
  });

  it("normalizes cached input from Codex CLI tool completion usage", async () => {
    await appendRequestLog({
      category: "model.response",
      action: "codex.tool.complete",
      providerKind: "codex-cli",
      response: {
        ok: true,
        status: "succeeded",
        usage: {
          input_tokens: 100,
          cached_input_tokens: 80,
          output_tokens: 10,
          total_tokens: 9_999
        }
      }
    });

    const page = await readRequestLogPage({ page: 1, pageSize: 10 });
    expect(page.logs[0]).toMatchObject({
      tokenUsage: {
        input: 100,
        output: 10,
        total: 110,
        cachedInput: 80,
        cacheRate: 0.8
      }
    });
  });

  it("uses Anthropic cache creation breakdown when the aggregate is absent", async () => {
    await appendRequestLog({
      category: "model.response",
      action: "anthropic.messages.complete",
      providerKind: "anthropic-compatible",
      response: {
        usage: {
          input_tokens: 10,
          cache_creation: {
            ephemeral_5m_input_tokens: 20,
            ephemeral_1h_input_tokens: 30
          },
          cache_read_input_tokens: 40,
          output_tokens: 5
        }
      }
    });

    const page = await readRequestLogPage({ page: 1, pageSize: 10 });
    expect(page.logs[0]).toMatchObject({
      tokenUsage: {
        input: 100,
        output: 5,
        total: 105,
        cachedInput: 40,
        cacheRate: 0.4
      }
    });
  });

  it("paginates newest-first request logs and keeps query totals scoped", async () => {
    const marker = randomUUID();
    await appendRequestLog({ category: "runtime.action", action: "first", request: { text: `${marker} alpha` } });
    await appendRequestLog({ category: "runtime.action", action: "second", request: { text: `${marker} beta` } });
    await appendRequestLog({ category: "runtime.action", action: "third", request: { text: `${marker} alpha` } });

    const firstPage = await readRequestLogPage({ query: marker, page: 1, pageSize: 2 });
    expect(firstPage).toMatchObject({ page: 1, pageSize: 2, total: 3, pageCount: 2 });
    expect(firstPage.logs.map((log: { action?: string }) => log.action)).toEqual(["third", "second"]);
    const filtered = await readRequestLogPage({ query: `${marker} alpha`, page: 1, pageSize: 10 });
    expect(filtered).toMatchObject({ total: 2, pageCount: 1 });
  });
});
