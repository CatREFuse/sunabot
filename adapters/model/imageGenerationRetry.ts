import {
  APIConnectionError,
  APIError,
  APIUserAbortError
} from "openai";

export const IMAGE_GENERATION_MAX_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [1_000, 2_000] as const;

export interface ImageGenerationAttemptContext {
  attempt: number;
  maxAttempts: number;
}

export interface ImageGenerationFailureContext extends ImageGenerationAttemptContext {
  willRetry: boolean;
  retryDelayMs: number;
}

export interface ImageGenerationRetryOptions {
  sleep?: (delayMs: number) => Promise<void>;
  onAttemptFailure?: (error: unknown, context: ImageGenerationFailureContext) => void | Promise<void>;
}

export class ImageGenerationTransportError extends Error {
  constructor(cause: unknown) {
    super("Image generation transport failed before the response completed.", { cause });
    this.name = "ImageGenerationTransportError";
  }
}

export class ImageGenerationHttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly responseSummary?: unknown
  ) {
    super(message);
    this.name = "ImageGenerationHttpError";
  }
}

export async function runImageGenerationWithRetry<T>(
  operation: (context: ImageGenerationAttemptContext) => Promise<T>,
  options: ImageGenerationRetryOptions = {}
) {
  const sleep = options.sleep ?? defaultSleep;
  for (let attempt = 1; attempt <= IMAGE_GENERATION_MAX_ATTEMPTS; attempt += 1) {
    try {
      const value = await operation({ attempt, maxAttempts: IMAGE_GENERATION_MAX_ATTEMPTS });
      return { value, attempt, maxAttempts: IMAGE_GENERATION_MAX_ATTEMPTS };
    } catch (error) {
      const willRetry = attempt < IMAGE_GENERATION_MAX_ATTEMPTS && isRetryableImageGenerationError(error);
      const retryDelayMs = willRetry ? RETRY_DELAYS_MS[attempt - 1] ?? 0 : 0;
      await options.onAttemptFailure?.(error, {
        attempt,
        maxAttempts: IMAGE_GENERATION_MAX_ATTEMPTS,
        willRetry,
        retryDelayMs
      });
      if (!willRetry) throw error;
      await sleep(retryDelayMs);
    }
  }
  throw new Error("Image generation retry loop ended unexpectedly.");
}

export function isRetryableImageGenerationError(error: unknown) {
  if (isImageGenerationCancellation(error)) return false;
  if (error instanceof ImageGenerationTransportError) return true;
  if (error instanceof APIConnectionError) return true;
  const status = imageGenerationErrorStatus(error);
  return status === 408 || status === 429 || (status != null && status >= 500 && status <= 599);
}

export function isImageGenerationCancellation(error: unknown) {
  return error instanceof APIUserAbortError ||
    (error instanceof Error && error.name === "AbortError");
}

export function imageGenerationErrorStatus(error: unknown) {
  if (error instanceof ImageGenerationHttpError) return error.status;
  if (error instanceof APIError && typeof error.status === "number") return error.status;
  return undefined;
}

export function imageGenerationErrorCode(error: unknown) {
  const cause = immediateCause(error);
  const directCode = errorCode(cause);
  if (directCode) return directCode;
  if (cause instanceof Error) return errorCode(cause.cause);
  return undefined;
}

function immediateCause(error: unknown) {
  if (!(error instanceof ImageGenerationTransportError) && !(error instanceof APIConnectionError)) return undefined;
  return error.cause;
}

function errorCode(error: unknown) {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

function defaultSleep(delayMs: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, delayMs));
}
