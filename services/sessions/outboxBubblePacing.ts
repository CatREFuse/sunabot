import type { OutboxBubbleSequenceV1 } from "../../packages/contracts/session/assistantReplyMetadata.js";

export const OUTBOX_BUBBLE_DELAY_MIN_MS = 500;
export const OUTBOX_BUBBLE_DELAY_MAX_MS = 2_000;

export interface OutboxBubblePacingDependencies {
  random?: () => number;
  sleep?: (delayMs: number, signal: AbortSignal) => Promise<void>;
}

export async function waitForOutboxBubble(
  sequence: OutboxBubbleSequenceV1 | undefined,
  signal: AbortSignal,
  dependencies: OutboxBubblePacingDependencies = {}
) {
  if (!sequence || sequence.index === 0) return 0;
  const delayMs = randomBubbleDelay(dependencies.random ?? Math.random);
  await (dependencies.sleep ?? abortableSleep)(delayMs, signal);
  return delayMs;
}

export function randomBubbleDelay(random: () => number = Math.random) {
  const value = random();
  if (!Number.isFinite(value) || value < 0 || value >= 1) {
    throw new Error("Outbox bubble random value must be between 0 (inclusive) and 1 (exclusive).");
  }
  return OUTBOX_BUBBLE_DELAY_MIN_MS + Math.floor(
    value * (OUTBOX_BUBBLE_DELAY_MAX_MS - OUTBOX_BUBBLE_DELAY_MIN_MS + 1)
  );
}

function abortableSleep(delayMs: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new Error("Outbox bubble delivery was cancelled."));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, delayMs);
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error("Outbox bubble delivery was cancelled."));
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}
