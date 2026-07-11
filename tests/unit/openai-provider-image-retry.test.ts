// @vitest-environment node
import fs from "node:fs";
import { APIConnectionError } from "openai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderConfig } from "../../src/types.js";

const appendRequestLog = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("../../src/requestLog.js", () => ({ appendRequestLog }));

import { OpenAIProvider } from "../../src/openaiProvider.js";

describe("OpenAIProvider image generation retries", () => {
  const sleep = vi.fn(async () => undefined);

  beforeEach(() => {
    appendRequestLog.mockClear();
    sleep.mockClear();
    vi.spyOn(fs, "mkdirSync").mockImplementation(() => undefined);
    vi.spyOn(fs, "writeFileSync").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("retries a Codex transport failure and logs both attempts", async () => {
    const provider = new OpenAIProvider(providerConfig("codex-responses"), { imageRetrySleep: sleep });
    vi.spyOn(provider as never, "getApiKey").mockReturnValue("test-token");
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(fetchFailure("ECONNRESET"))
      .mockResolvedValueOnce(imageResponse());

    const result = await provider.generateImage("portrait", "1024x1024", "high", [], { runId: "retry-codex" });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      tools: [{ type: "image_generation", quality: "high" }]
    });
    expect(sleep).toHaveBeenCalledOnce();
    expect(sleep).toHaveBeenCalledWith(1_000);
    expect(fs.writeFileSync).toHaveBeenCalledOnce();
    expect(result.url).toMatch(/^\/generated-images\/.+\.png$/);

    const requests = modelLogs("model.request", "codex.image.generate");
    const responses = modelLogs("model.response", "codex.image.generate");
    expect(requests.map((entry) => entry.metadata)).toEqual([
      expect.objectContaining({ attempt: 1, maxAttempts: 3, runId: "retry-codex" }),
      expect.objectContaining({ attempt: 2, maxAttempts: 3, runId: "retry-codex" })
    ]);
    expect(responses[0]?.response).toMatchObject({
      ok: false,
      willRetry: true,
      retryDelayMs: 1_000,
      errorCode: "ECONNRESET"
    });
    expect(responses[1]?.response).toMatchObject({ ok: true, status: 200 });
    expect(responses[1]?.metadata).toMatchObject({ attempt: 2, maxAttempts: 3 });
  });

  it("stops after three Codex transport failures", async () => {
    const provider = new OpenAIProvider(providerConfig("codex-responses"), { imageRetrySleep: sleep });
    vi.spyOn(provider as never, "getApiKey").mockReturnValue("test-token");
    const finalError = fetchFailure("ETIMEDOUT");
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(fetchFailure("ECONNRESET"))
      .mockRejectedValueOnce(fetchFailure("EPIPE"))
      .mockRejectedValueOnce(finalError);

    await expect(provider.generateImage("portrait", "1024x1024", "high")).rejects.toThrow(
      "before receiving an HTTP response"
    );

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls).toEqual([[1_000], [2_000]]);
    expect(fs.writeFileSync).not.toHaveBeenCalled();
    expect(modelLogs("model.response", "codex.image.generate").at(-1)?.response).toMatchObject({
      ok: false,
      willRetry: false,
      retryDelayMs: 0,
      errorCode: "ETIMEDOUT"
    });
  });

  it("does not retry deterministic Codex HTTP or successful invalid-image responses", async () => {
    const provider = new OpenAIProvider(providerConfig("codex-responses"), { imageRetrySleep: sleep });
    vi.spyOn(provider as never, "getApiKey").mockReturnValue("test-token");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(
      JSON.stringify({ error: { message: "unauthorized" } }),
      { status: 401, headers: { "content-type": "application/json" } }
    ));

    await expect(provider.generateImage("portrait", "1024x1024", "high")).rejects.toThrow("unauthorized");
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();

    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ status: "completed", output: [] }), {
      status: 200,
      headers: { "content-type": "application/json" }
    }));
    await expect(provider.generateImage("portrait", "1024x1024", "high")).rejects.toThrow("没有收到生图结果");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("retries a retryable Codex HTTP response", async () => {
    const provider = new OpenAIProvider(providerConfig("codex-responses"), { imageRetrySleep: sleep });
    vi.spyOn(provider as never, "getApiKey").mockReturnValue("test-token");
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: "temporarily unavailable" } }), {
        status: 503,
        headers: { "content-type": "application/json" }
      }))
      .mockResolvedValueOnce(imageResponse());

    await provider.generateImage("portrait", "1024x1024", "high");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(1_000);
    expect(modelLogs("model.response", "codex.image.generate")[0]?.response).toMatchObject({
      status: 503,
      willRetry: true,
      retryDelayMs: 1_000
    });
  });

  it("disables SDK retries and applies the same three-attempt cap", async () => {
    const provider = new OpenAIProvider(providerConfig("openai-responses"), { imageRetrySleep: sleep });
    const create = vi.fn()
      .mockRejectedValueOnce(new APIConnectionError({ message: "network", cause: networkError("ECONNRESET") }))
      .mockResolvedValueOnce(imagePayload());
    const createClient = vi.spyOn(provider as never, "createClient").mockReturnValue({
      responses: { create }
    });

    await provider.generateImage("portrait", "1024x1024", "high");

    expect(createClient).toHaveBeenCalledWith({ maxRetries: 0 });
    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[0]?.[0]).toMatchObject({
      tools: [{ type: "image_generation", quality: "high" }]
    });
    expect(sleep).toHaveBeenCalledWith(1_000);
    expect(fs.writeFileSync).toHaveBeenCalledOnce();
    expect(modelLogs("model.request", "image.generate")).toHaveLength(2);
  });

  it("never exceeds three SDK image requests", async () => {
    const provider = new OpenAIProvider(providerConfig("openai-responses"), { imageRetrySleep: sleep });
    const lastError = new APIConnectionError({ message: "last network failure", cause: networkError("ETIMEDOUT") });
    const create = vi.fn()
      .mockRejectedValueOnce(new APIConnectionError({ message: "network one", cause: networkError("ECONNRESET") }))
      .mockRejectedValueOnce(new APIConnectionError({ message: "network two", cause: networkError("EPIPE") }))
      .mockRejectedValueOnce(lastError);
    vi.spyOn(provider as never, "createClient").mockReturnValue({ responses: { create } });

    await expect(provider.generateImage("portrait", "1024x1024", "high")).rejects.toBe(lastError);

    expect(create).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls).toEqual([[1_000], [2_000]]);
    expect(modelLogs("model.response", "image.generate").at(-1)?.response).toMatchObject({
      willRetry: false,
      retryDelayMs: 0,
      errorCode: "ETIMEDOUT"
    });
  });
});

function providerConfig(kind: ProviderConfig["kind"]): ProviderConfig {
  return {
    id: `retry-${kind}`,
    label: "Retry Test",
    kind,
    enabled: true,
    model: "gpt-5.6-terra",
    imageModel: "gpt-image-2",
    baseUrl: kind === "codex-responses" ? "https://chatgpt.com/backend-api/codex" : "https://api.openai.com/v1",
    apiKeyEnv: "SUNABOT_TEST_MISSING_KEY",
    temperature: 0.2,
    maxOutputTokens: 1_200,
    reasoningEffort: "medium"
  };
}

function imagePayload() {
  return {
    status: "completed",
    output: [{
      type: "image_generation_call",
      status: "completed",
      result: Buffer.from("png-result").toString("base64")
    }]
  };
}

function imageResponse() {
  return new Response(JSON.stringify(imagePayload()), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

function fetchFailure(code: string) {
  return new TypeError("fetch failed", { cause: networkError(code) });
}

function networkError(code: string) {
  return Object.assign(new Error(code), { code });
}

function modelLogs(category: string, action: string) {
  return appendRequestLog.mock.calls
    .map((call) => call[0] as Record<string, any>)
    .filter((entry) => entry.category === category && entry.action === action);
}
