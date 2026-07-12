// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { RegistryProviderToolExecutor } from "../../adapters/model/provider/toolExecutor.js";
import {
  extractResponsesTextFromSse,
  parseResponsesSsePayload
} from "../../adapters/model/provider/streamDecoder.js";
import {
  fetchTextWithTransportRetry,
  resolveRetryDelayMs,
  waitForRetry
} from "../../adapters/model/provider/transport.js";

describe("provider adapter ports", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("decodes Codex SSE output items and completed text", () => {
    const message = {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "完成" }]
    };
    const stream = [
      `data: ${JSON.stringify({ type: "response.output_item.done", output_index: 0, item: message })}`,
      `data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", output: [message] } })}`
    ].join("\n\n");

    expect(parseResponsesSsePayload(stream)).toMatchObject({
      status: "completed",
      output: [message]
    });
    expect(extractResponsesTextFromSse(stream)).toBe("完成");
  });

  it("retries one transport failure without changing the request", async () => {
    const response = new Response("ok", { status: 200 });
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(response);
    const init: RequestInit = { method: "POST", body: "{}" };
    const beforeAttempt = vi.fn();
    const attemptFailed = vi.fn();

    const result = await fetchTextWithTransportRetry("https://example.test/responses", init, undefined, {
      beforeAttempt,
      attemptFailed
    });
    expect(result).toMatchObject({ response, text: "ok", attempt: 2, maxAttempts: 2 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls).toEqual([
      ["https://example.test/responses", init],
      ["https://example.test/responses", init]
    ]);
    expect(beforeAttempt.mock.calls).toEqual([
      [{ attempt: 1, maxAttempts: 2 }],
      [{ attempt: 2, maxAttempts: 2 }]
    ]);
    expect(attemptFailed).toHaveBeenCalledWith(expect.any(TypeError), {
      attempt: 1,
      maxAttempts: 2,
      willRetry: true,
      retryDelayMs: 150
    });
  });

  it("retries a response body read failure", async () => {
    const brokenResponse = {
      ok: true,
      status: 200,
      headers: new Headers(),
      text: vi.fn(async () => { throw new TypeError("terminated"); })
    } as unknown as Response;
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(brokenResponse)
      .mockResolvedValueOnce(new Response("complete", { status: 200 }));
    const attemptFailed = vi.fn();

    await expect(fetchTextWithTransportRetry("https://example.test/responses", {
      method: "POST"
    }, undefined, { attemptFailed })).resolves.toMatchObject({ text: "complete", attempt: 2 });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(attemptFailed).toHaveBeenCalledWith(expect.objectContaining({ message: "terminated" }), {
      attempt: 1,
      maxAttempts: 2,
      willRetry: true,
      status: 200,
      retryDelayMs: 150
    });
  });

  it("honors Retry-After and rejects an already aborted wait", async () => {
    expect(resolveRetryDelayMs(new Headers({ "retry-after": "1.25" }), 1)).toBe(1_250);
    expect(resolveRetryDelayMs({ headers: { "Retry-After-Ms": "275" } }, 1)).toBe(275);

    const controller = new AbortController();
    const reason = new Error("cancelled");
    controller.abort(reason);
    await expect(waitForRetry(1_000, controller.signal)).rejects.toBe(reason);

    const fetchMock = vi.spyOn(globalThis, "fetch");
    const beforeAttempt = vi.fn();
    await expect(fetchTextWithTransportRetry("https://example.test/responses", {}, controller.signal, {
      beforeAttempt
    })).rejects.toBe(reason);
    expect(beforeAttempt).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("delays an HTTP retry according to Retry-After", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("busy", {
        status: 503,
        headers: { "retry-after": "1" }
      }))
      .mockResolvedValueOnce(new Response("complete", { status: 200 }));

    const result = fetchTextWithTransportRetry("https://example.test/responses", { method: "POST" });
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toMatchObject({ text: "complete", attempt: 2 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("keeps unsupported tool dispatch inside the ToolExecutor boundary", async () => {
    const executor = new RegistryProviderToolExecutor();
    const [output] = await executor.execute([{
      type: "function_call",
      name: "unknown_tool",
      call_id: "call_unknown",
      arguments: "{}"
    }], {}, []);

    expect(output).toMatchObject({
      type: "function_call_output",
      call_id: "call_unknown"
    });
    expect(JSON.parse(String(output?.output))).toEqual({
      ok: false,
      error: "Unsupported tool: unknown_tool"
    });
  });
});
