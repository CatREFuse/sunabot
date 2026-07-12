import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { closeApplicationDataStores } from "../../adapters/sqlite/applicationDataStore.js";
import { appendRequestLog, readRequestLogPage, readTokenUsageSummary } from "../../src/requestLog.js";

afterEach(closeApplicationDataStores);

describe("request log token usage", () => {
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
      requests: 3
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
