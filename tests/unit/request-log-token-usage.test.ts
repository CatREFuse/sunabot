import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { applicationDataStore, closeApplicationDataStores } from "../../adapters/sqlite/applicationDataStore.js";
import { appendRequestLog, readModelCallStats, readRequestLogPage, readTokenUsageSummary } from "../../adapters/observability/requestLog.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  closeApplicationDataStores();
});

describe("request log token usage", () => {
  it("aggregates model calls by behavior and exact conversation", async () => {
    const conversationId = `group:${randomUUID()}`;
    const append = (stage: string, memoryKind?: "working_long_term" | "user_profile") => appendRequestLog({
      category: "model.response",
      action: "responses.complete",
      model: stage === "reply" ? "gpt-reply" : "gpt-shared",
      response: { usage: { input_tokens: 8, output_tokens: 2, total_tokens: 10 } },
      metadata: { conversationId, stage, ...(memoryKind ? { memoryKind } : {}) }
    });

    await append("reply");
    await appendRequestLog({
      category: "model.response",
      action: "responses.complete",
      model: "gpt-reply",
      response: { ok: false, error: "transport failed" },
      metadata: { conversationId, stage: "reply", transportAttempt: 1 }
    });
    await append("orchestrator");
    await append("memory", "working_long_term");
    await append("memory", "user_profile");
    await append("memory");
    await appendRequestLog({
      category: "model.response",
      action: "responses.complete",
      response: { usage: { input_tokens: 80, output_tokens: 20, total_tokens: 100 } },
      metadata: { conversationId: `${conversationId}:other`, stage: "reply" }
    });

    const fullJsonScan = vi.spyOn(applicationDataStore(), "readTokenUsageRecords")
      .mockImplementation(() => { throw new Error("model stats must use the aggregate table"); });
    expect(readModelCallStats({ conversationId })).toMatchObject({
      total: { requests: 6, total: 50 },
      behavior: {
        reply: { requests: 2, total: 10 },
        orchestrator: { requests: 1, total: 10 },
        memory: { requests: 2, total: 20 },
        other: { requests: 1, total: 10 }
      },
      memory: {
        total: { requests: 2, total: 20 },
        kinds: {
          working_long_term: { requests: 1, total: 10 },
          user_profile: { requests: 1, total: 10 }
        }
      },
      models: expect.arrayContaining([
        expect.objectContaining({
          model: "gpt-reply",
          total: expect.objectContaining({ requests: 2, total: 10 }),
          behavior: expect.objectContaining({ reply: expect.objectContaining({ requests: 2, total: 10 }) })
        }),
        expect.objectContaining({
          model: "gpt-shared",
          total: expect.objectContaining({ requests: 4, total: 40 })
        })
      ])
    });
    expect(fullJsonScan).not.toHaveBeenCalled();
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

  it("counts failed model responses without usage while leaving token totals unchanged", async () => {
    await appendRequestLog({
      category: "model.response",
      action: "responses.complete",
      model: "gpt-cache-test",
      response: {
        summary: {
          usage: {
            input_tokens: 100,
            input_tokens_details: { cached_tokens: 40 },
            output_tokens: 10,
            total_tokens: 110
          }
        }
      }
    });
    await appendRequestLog({
      category: "model.response",
      action: "responses.complete",
      model: "gpt-cache-test",
      response: { ok: false, status: 500, error: "transport failed" }
    });

    expect(readTokenUsageSummary(new Date().getTimezoneOffset()).today).toMatchObject({
      input: 100,
      cachedInput: 40,
      output: 10,
      total: 110,
      cacheRate: 0.4,
      requests: 2
    });
  });

  it("exposes missing model ids with a selectable unlabeled sentinel", async () => {
    await appendRequestLog({
      category: "model.response",
      action: "responses.complete",
      response: { usage: { input_tokens: 8, output_tokens: 2, total_tokens: 10 } },
      metadata: { stage: "reply" }
    });

    expect(readModelCallStats().models).toEqual([
      expect.objectContaining({ model: "__unlabeled__", total: expect.objectContaining({ requests: 1, total: 10 }) })
    ]);
  });

  it("filters timeline usage by model and function without changing available models", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-13T08:00:00.000Z"));
    const append = (model: string | undefined, stage: string, total: number) => appendRequestLog({
      category: "model.response",
      action: "responses.complete",
      ...(model == null ? {} : { model }),
      response: { usage: { input_tokens: total - 10, output_tokens: 10, total_tokens: total } },
      metadata: { stage, ...(stage === "memory" ? { memoryKind: "working_long_term" } : {}) }
    });

    await append("gpt-alpha", "reply", 100);
    await append("gpt-beta", "memory", 40);
    await append(undefined, "orchestrator", 20);

    const all = readTokenUsageSummary(0);
    const model = readTokenUsageSummary(0, { model: "gpt-alpha" });
    const behavior = readTokenUsageSummary(0, { behavior: "memory" });
    const combined = readTokenUsageSummary(0, { model: "gpt-alpha", behavior: "memory" });
    const unlabeled = readTokenUsageSummary(0, { model: "__unlabeled__" });

    expect(all.today).toMatchObject({ total: 160, requests: 3 });
    expect(all.filters).toEqual({
      models: ["gpt-alpha", "gpt-beta", "__unlabeled__"],
      model: "",
      behavior: ""
    });
    expect(model.today).toMatchObject({ total: 100, requests: 1 });
    expect(model.filters.models).toEqual(all.filters.models);
    expect(behavior.today).toMatchObject({ total: 40, requests: 1 });
    expect(combined.today).toMatchObject({ total: 0, requests: 0 });
    expect(unlabeled.today).toMatchObject({ total: 20, requests: 1 });
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

  it("redacts a bare key query parameter from error strings", async () => {
    await appendRequestLog({
      category: "model.response",
      action: "gemini.generate-content.complete",
      response: {
        ok: false,
        error: "request failed: https://example.test/generate?key=super-secret&alt=sse"
      }
    });

    const page = await readRequestLogPage({ page: 1, pageSize: 1 });
    expect(page.logs[0]).toMatchObject({
      response: {
        error: "request failed: https://example.test/generate?key=[REDACTED]&alt=sse"
      }
    });
  });

  it("keeps complete model prompts and response payloads while redacting credentials", async () => {
    const prompt = `SYSTEM-PROMPT:${"提示词正文".repeat(4_000)}:END`;
    const returnedText = `MODEL-RESPONSE:${"模型返回".repeat(4_000)}:END`;

    await appendRequestLog({
      category: "model.request",
      action: "responses.complete",
      request: {
        authorization: "Bearer request-secret",
        input: [{ role: "system", content: [{ type: "input_text", text: prompt }] }]
      }
    });
    await appendRequestLog({
      category: "model.response",
      action: "responses.complete",
      response: {
        accessToken: "response-secret",
        payload: { output_text: returnedText }
      }
    });

    const page = await readRequestLogPage({ page: 1, pageSize: 2 });
    expect(page.logs[0]).toMatchObject({
      response: {
        accessToken: "[REDACTED]",
        payload: { output_text: returnedText }
      }
    });
    expect(page.logs[1]).toMatchObject({
      request: {
        authorization: "[REDACTED]",
        input: [{ content: [{ text: prompt }] }]
      }
    });
    expect(JSON.stringify(page.logs)).not.toContain("[truncated:");
    expect(JSON.stringify(page.logs)).not.toContain("request-secret");
    expect(JSON.stringify(page.logs)).not.toContain("response-secret");
  });
});
