// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  OUTBOX_BUBBLE_DELAY_MAX_MS,
  OUTBOX_BUBBLE_DELAY_MIN_MS,
  randomBubbleDelay,
  waitForOutboxBubble
} from "../../services/sessions/outboxBubblePacing.js";

describe("outbox bubble pacing", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("maps the random range to an inclusive 500-2000ms delay", () => {
    expect(randomBubbleDelay(() => 0)).toBe(OUTBOX_BUBBLE_DELAY_MIN_MS);
    expect(randomBubbleDelay(() => 0.999_999)).toBe(OUTBOX_BUBBLE_DELAY_MAX_MS);
    expect(() => randomBubbleDelay(() => 1)).toThrow("between 0 (inclusive) and 1 (exclusive)");
  });

  it("does not delay the first bubble or a legacy single bubble", async () => {
    const random = vi.fn(() => 0.5);
    const sleep = vi.fn(async () => undefined);
    const signal = new AbortController().signal;

    await expect(waitForOutboxBubble(undefined, signal, { random, sleep })).resolves.toBe(0);
    await expect(waitForOutboxBubble(
      { schemaVersion: 1, index: 0, total: 3 },
      signal,
      { random, sleep }
    )).resolves.toBe(0);

    expect(random).not.toHaveBeenCalled();
    expect(sleep).not.toHaveBeenCalled();
  });

  it("waits once before every later bubble with injectable random and sleep", async () => {
    const signal = new AbortController().signal;
    const sleep = vi.fn(async () => undefined);

    await expect(waitForOutboxBubble(
      { schemaVersion: 1, index: 2, total: 3 },
      signal,
      { random: () => 0, sleep }
    )).resolves.toBe(500);

    expect(sleep).toHaveBeenCalledOnce();
    expect(sleep).toHaveBeenCalledWith(500, signal);
  });

  it("cancels a pending delay before the remote transport starts", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const waiting = waitForOutboxBubble(
      { schemaVersion: 1, index: 1, total: 2 },
      controller.signal,
      { random: () => 0 }
    );

    controller.abort(new Error("coordinator stopped"));

    await expect(waiting).rejects.toThrow("coordinator stopped");
    expect(vi.getTimerCount()).toBe(0);
  });
});
