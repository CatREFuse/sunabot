// @vitest-environment node
import {
  APIConnectionError,
  APIUserAbortError
} from "openai";
import { describe, expect, it, vi } from "vitest";
import {
  ImageGenerationHttpError,
  ImageGenerationTransportError,
  imageGenerationErrorCode,
  isImageGenerationCancellation,
  isRetryableImageGenerationError,
  runImageGenerationWithRetry
} from "../../adapters/model/imageGenerationRetry.js";

describe("image generation retry policy", () => {
  it("returns immediately on the first successful attempt", async () => {
    const operation = vi.fn(async () => "image");
    const sleep = vi.fn(async () => undefined);

    const result = await runImageGenerationWithRetry(operation, { sleep });

    expect(result).toEqual({ value: "image", attempt: 1, maxAttempts: 3 });
    expect(operation).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
  });

  it("retries recoverable failures with one and two second backoff", async () => {
    const operation = vi.fn()
      .mockRejectedValueOnce(new ImageGenerationTransportError(networkError("ECONNRESET")))
      .mockRejectedValueOnce(new ImageGenerationHttpError(503, "unavailable"))
      .mockResolvedValueOnce("image");
    const sleep = vi.fn(async () => undefined);
    const onAttemptFailure = vi.fn(async () => undefined);

    const result = await runImageGenerationWithRetry(operation, { sleep, onAttemptFailure });

    expect(result).toEqual({ value: "image", attempt: 3, maxAttempts: 3 });
    expect(operation).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls).toEqual([[1_000], [2_000]]);
    expect(onAttemptFailure.mock.calls.map((call) => call[1])).toEqual([
      { attempt: 1, maxAttempts: 3, willRetry: true, retryDelayMs: 1_000 },
      { attempt: 2, maxAttempts: 3, willRetry: true, retryDelayMs: 2_000 }
    ]);
  });

  it("throws the final error after three recoverable failures", async () => {
    const finalError = new ImageGenerationHttpError(500, "last failure");
    const operation = vi.fn()
      .mockRejectedValueOnce(new ImageGenerationHttpError(429, "limited"))
      .mockRejectedValueOnce(new ImageGenerationHttpError(502, "gateway"))
      .mockRejectedValueOnce(finalError);
    const sleep = vi.fn(async () => undefined);
    const onAttemptFailure = vi.fn(async () => undefined);

    await expect(runImageGenerationWithRetry(operation, { sleep, onAttemptFailure })).rejects.toBe(finalError);
    expect(operation).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls).toEqual([[1_000], [2_000]]);
    expect(onAttemptFailure.mock.calls.at(-1)?.[1]).toEqual({
      attempt: 3,
      maxAttempts: 3,
      willRetry: false,
      retryDelayMs: 0
    });
  });

  it.each([408, 429, 500, 503, 599])("retries HTTP %i", (status) => {
    expect(isRetryableImageGenerationError(new ImageGenerationHttpError(status, "retry"))).toBe(true);
  });

  it.each([400, 401, 403, 404, 409, 422])("does not retry HTTP %i", (status) => {
    expect(isRetryableImageGenerationError(new ImageGenerationHttpError(status, "stop"))).toBe(false);
  });

  it("retries explicit SDK connection errors and extracts only the immediate network code", () => {
    const cause = networkError("ETIMEDOUT");
    const error = new APIConnectionError({ message: "connection failed", cause });

    expect(isRetryableImageGenerationError(error)).toBe(true);
    expect(imageGenerationErrorCode(error)).toBe("ETIMEDOUT");
  });

  it("never retries cancellation or generic status-less errors", async () => {
    const abort = new APIUserAbortError({ message: "cancelled" });
    const domAbort = new Error("aborted");
    domAbort.name = "AbortError";
    const generic = new Error("parse failed");

    expect(isImageGenerationCancellation(abort)).toBe(true);
    expect(isImageGenerationCancellation(domAbort)).toBe(true);
    expect(isRetryableImageGenerationError(abort)).toBe(false);
    expect(isRetryableImageGenerationError(domAbort)).toBe(false);
    expect(isRetryableImageGenerationError(generic)).toBe(false);

    const operation = vi.fn(async () => { throw generic; });
    await expect(runImageGenerationWithRetry(operation, { sleep: vi.fn() })).rejects.toBe(generic);
    expect(operation).toHaveBeenCalledOnce();
  });
});

function networkError(code: string) {
  return Object.assign(new Error(code), { code });
}
