import { AUXILIARY_MODEL_RESPONSE_TIMEOUT_MS } from "./modelGateway.js";

export class ModelTaskDeadlineError extends Error {
  override readonly name = "TimeoutError";

  constructor(readonly timeoutMs: number) {
    super(`model task timed out after ${timeoutMs}ms`);
  }
}

export interface ModelTaskDeadlineOptions {
  timeoutMs?: number;
  parentSignal?: AbortSignal;
  timeoutError?: (timeoutMs: number) => unknown;
}

export async function runModelTaskWithinDeadline<T>(
  task: (signal: AbortSignal) => Promise<T>,
  options: ModelTaskDeadlineOptions = {}
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? AUXILIARY_MODEL_RESPONSE_TIMEOUT_MS;
  const controller = new AbortController();
  let rejectAbort!: (reason: unknown) => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const onAbort = () => {
    rejectAbort(controller.signal.reason ?? new Error("model task aborted"));
  };
  const onParentAbort = () => {
    controller.abort(options.parentSignal?.reason ?? new Error("model task aborted"));
  };
  controller.signal.addEventListener("abort", onAbort, { once: true });
  if (options.parentSignal?.aborted) onParentAbort();
  else options.parentSignal?.addEventListener("abort", onParentAbort, { once: true });
  const timer = setTimeout(() => {
    controller.abort(
      options.timeoutError?.(timeoutMs) ?? new ModelTaskDeadlineError(timeoutMs)
    );
  }, timeoutMs);
  timer.unref?.();
  try {
    controller.signal.throwIfAborted();
    return await Promise.race([Promise.resolve().then(() => task(controller.signal)), aborted]);
  } finally {
    clearTimeout(timer);
    controller.signal.removeEventListener("abort", onAbort);
    options.parentSignal?.removeEventListener("abort", onParentAbort);
  }
}
