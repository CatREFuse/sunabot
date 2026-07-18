// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  EmojiGenerationGate,
  EmojiNormalizationGate
} from "../../services/emojis/emojiOperationGate.js";

describe("emoji operation gates", () => {
  it("deduplicates keys, limits each Agent independently, and releases slots", () => {
    const gate = new EmojiGenerationGate(2);
    const first = gate.tryAcquire("koharu", "开心");
    const second = gate.tryAcquire("koharu", "哭");
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(gate.tryAcquire("koharu", "开心")).toEqual({ ok: false, reason: "key" });
    expect(gate.tryAcquire("koharu", "认真")).toEqual({ ok: false, reason: "capacity" });

    const otherAgent = gate.tryAcquire("plana", "开心");
    expect(otherAgent.ok).toBe(true);
    if (first.ok) first.release();
    const replacement = gate.tryAcquire("koharu", "开心");
    expect(replacement.ok).toBe(true);

    if (first.ok) first.release();
    if (second.ok) second.release();
    if (otherAgent.ok) otherAgent.release();
    if (replacement.ok) replacement.release();
    expect(gate.tryAcquire("koharu", "认真").ok).toBe(true);
  });

  it("rejects normalization immediately at capacity, isolates Agents, and releases idempotently", () => {
    const gate = new EmojiNormalizationGate(1);
    const first = gate.tryAcquire("koharu");
    expect(first.ok).toBe(true);

    let rejectedOperations = 0;
    const rejected = Array.from({ length: 64 }, () => {
      const admission = gate.tryAcquire("koharu");
      if (admission.ok) rejectedOperations += 1;
      return admission;
    });
    expect(rejected).toEqual(Array.from(
      { length: 64 },
      () => ({ ok: false, reason: "capacity" })
    ));
    expect(rejectedOperations).toBe(0);

    const otherAgent = gate.tryAcquire("plana");
    expect(otherAgent.ok).toBe(true);
    if (first.ok) {
      first.release();
      first.release();
    }
    const retry = gate.tryAcquire("koharu");
    expect(retry.ok).toBe(true);
    if (retry.ok) retry.release();
    if (otherAgent.ok) otherAgent.release();
  });
});
