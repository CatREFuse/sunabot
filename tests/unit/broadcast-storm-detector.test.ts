import { describe, expect, it } from "vitest";
import { BroadcastStormDetector } from "../../services/orchestration/broadcastStormDetector.js";

describe("BroadcastStormDetector", () => {
  it("blocks every reply after one Agent pair reaches the configured threshold", () => {
    let now = Date.parse("2026-07-14T00:00:00.000Z");
    const detector = new BroadcastStormDetector({
      enabled: true,
      windowMinutes: 2,
      replyThreshold: 3,
      cooldownMinutes: 1
    }, () => now);

    expect(detector.observe(observation("message-1", "plana", "arona"))).toMatchObject({
      counted: true,
      triggered: false
    });
    now += 30_000;
    expect(detector.observe(observation("message-2", "arona", "plana"))).toMatchObject({
      counted: true,
      triggered: false
    });
    now += 30_000;
    expect(detector.observe(observation("message-3", "plana", "arona"))).toEqual({
      counted: true,
      triggered: true,
      blockedUntil: "2026-07-14T00:02:00.000Z"
    });

    expect(detector.canReplyTo("2026-07-14T00:01:01.000Z")).toBe(false);
    now += 60_000;
    expect(detector.canReplyTo("2026-07-14T00:01:30.000Z")).toBe(false);
    expect(detector.canReplyTo("2026-07-14T00:02:01.000Z")).toBe(true);
  });

  it("deduplicates messages and isolates groups and Agent pairs", () => {
    const detector = new BroadcastStormDetector({
      enabled: true,
      windowMinutes: 2,
      replyThreshold: 2,
      cooldownMinutes: 1
    });

    expect(detector.observe(observation("message-1", "plana", "arona", 100))).toMatchObject({ counted: true });
    expect(detector.observe(observation("message-1", "plana", "arona", 100))).toMatchObject({ counted: false });
    expect(detector.observe(observation("message-2", "plana", "seia", 100))).toMatchObject({ triggered: false });
    expect(detector.observe(observation("message-3", "plana", "arona", 200))).toMatchObject({ triggered: false });
    expect(detector.observe(observation("message-4", "plana", "arona", 100))).toMatchObject({ triggered: true });
  });

  it("expires old observations and clears suppression when disabled", () => {
    let now = Date.parse("2026-07-14T00:00:00.000Z");
    const detector = new BroadcastStormDetector({
      enabled: true,
      windowMinutes: 1,
      replyThreshold: 2,
      cooldownMinutes: 5
    }, () => now);

    detector.observe(observation("message-1", "plana", "arona"));
    now += 61_000;
    expect(detector.observe(observation("message-2", "plana", "arona"))).toMatchObject({ triggered: false });
    now += 1_000;
    expect(detector.observe(observation("message-3", "arona", "plana"))).toMatchObject({ triggered: true });

    detector.updateConfig({ enabled: false, windowMinutes: 1, replyThreshold: 2, cooldownMinutes: 5 });
    expect(detector.canReplyTo("2026-07-13T00:00:00.000Z")).toBe(true);
    expect(detector.status()).toEqual({ enabled: false, blocked: false });
  });

  it("does not count replies within one Agent", () => {
    const detector = new BroadcastStormDetector({
      enabled: true,
      windowMinutes: 2,
      replyThreshold: 1,
      cooldownMinutes: 1
    });

    expect(detector.observe(observation("message-1", "plana", "plana"))).toEqual({
      counted: false,
      triggered: false
    });
  });

  it("does not count delayed messages outside the configured window", () => {
    const detector = new BroadcastStormDetector({
      enabled: true,
      windowMinutes: 2,
      replyThreshold: 1,
      cooldownMinutes: 1
    }, () => Date.parse("2026-07-14T00:10:00.000Z"));

    expect(detector.observe({
      ...observation("delayed-message", "plana", "arona"),
      occurredAt: "2026-07-14T00:07:59.000Z"
    })).toEqual({ counted: false, triggered: false });
  });
});

function observation(
  messageKey: string,
  sourceAgentId: string,
  targetAgentId: string,
  groupId = 100
) {
  return { messageKey, groupId, sourceAgentId, targetAgentId };
}
