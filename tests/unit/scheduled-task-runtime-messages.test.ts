import { describe, expect, it } from "vitest";
import {
  decodeScheduledCallbackDelivery,
  decodeScheduledCallbackOutbox,
  scheduledCallbackDeliveryEnvelope,
  scheduledCallbackOutboxEnvelope,
  type ScheduledCallbackPayloadV1
} from "../../packages/contracts/session/scheduledTaskRuntimeMessages.js";

const payload: ScheduledCallbackPayloadV1 = {
  type: "scheduled_callback",
  taskId: "task-1",
  taskRevision: 3,
  runId: "run-1",
  taskName: "每日提醒",
  scheduledFor: "2026-07-19T01:00:00.000Z",
  triggeredAt: "2026-07-19T01:00:01.000Z",
  text: "该出发了。",
  target: {
    conversationId: "account:qq-main:group:123456",
    accountId: "qq-main",
    scope: "user_group",
    userId: 10001,
    groupId: 123456,
    mentionUserIds: [10001, 10002]
  }
};

describe("scheduled callback durable messages", () => {
  it("round-trips delivery and outbox envelopes", () => {
    const options = { conversationId: payload.target.conversationId, correlationId: payload.runId };
    expect(decodeScheduledCallbackDelivery(scheduledCallbackDeliveryEnvelope(payload, options))).toEqual(payload);
    expect(decodeScheduledCallbackOutbox(scheduledCallbackOutboxEnvelope(payload, options))).toEqual(payload);
  });

  it("rejects identity mismatches and private mentions", () => {
    const options = { conversationId: payload.target.conversationId, correlationId: payload.runId };
    const mismatched = scheduledCallbackDeliveryEnvelope({
      ...payload,
      target: { ...payload.target, accountId: "other" }
    }, options);
    expect(() => decodeScheduledCallbackDelivery(mismatched)).toThrow(/accountId/);

    const privateWithMention = scheduledCallbackOutboxEnvelope({
      ...payload,
      target: {
        conversationId: "private:10001",
        accountId: "primary",
        scope: "private",
        userId: 10001,
        mentionUserIds: [10002]
      }
    }, { conversationId: "private:10001", correlationId: payload.runId });
    expect(() => decodeScheduledCallbackOutbox(privateWithMention)).toThrow(/Private/);
  });
});
