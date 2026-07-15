import type { OutboxRecord, SessionStore } from "./sessionStore.js";
import type { OutboxDeliveryContext } from "./sessionCoordinatorTypes.js";

interface OutboxDeliveryContextOptions {
  outbox: OutboxRecord;
  store: SessionStore;
  workerId: string;
  signal: AbortSignal;
  assertUsable(): void;
}

export function createOutboxDeliveryContext(options: OutboxDeliveryContextOptions) {
  const { outbox, store, workerId, signal, assertUsable } = options;
  let phase: OutboxDeliveryContext["phase"] = outbox.status === "sent_remote" ? "settle" : "send";
  let remoteReceipt = outbox.remoteReceipt;
  let remoteSucceeded = false;
  const completedSteps = new Set(outbox.completedSettleSteps);
  const context: OutboxDeliveryContext = {
    signal,
    get phase() { return phase; },
    get remoteReceipt() { return remoteReceipt; },
    sendRemote: async <T>(operation: () => T | Promise<T>) => {
      if (phase !== "send") throw new Error(`Outbox ${outbox.id} remote delivery is already settled.`);
      assertUsable();
      store.markOutboxTransportStarted(outbox.id, workerId);
      const receipt = await operation();
      assertUsable();
      const sentRemote = store.markOutboxRemoteSent(outbox.id, workerId, receipt);
      phase = "settle";
      remoteReceipt = sentRemote.remoteReceipt;
      remoteSucceeded = true;
      return receipt;
    },
    settleStep: async <T>(step: string, operation: (idempotencyKey: string) => T | Promise<T>) => {
      const normalizedStep = requiredStep(step);
      if (phase !== "settle") throw new Error(`Outbox ${outbox.id} remote delivery is not settled.`);
      if (completedSteps.has(normalizedStep)) return undefined;
      assertUsable();
      const value = await operation(settleIdempotencyKey(outbox.id, normalizedStep));
      assertUsable();
      store.completeOutboxSettleStep(outbox.id, workerId, normalizedStep);
      completedSteps.add(normalizedStep);
      return value;
    },
    settleEffectStep: async <T>(step: string, operation: (idempotencyKey: string) => T | Promise<T>) => {
      const normalizedStep = requiredStep(step);
      if (phase !== "settle") throw new Error(`Outbox ${outbox.id} remote delivery is not settled.`);
      if (completedSteps.has(normalizedStep)) return undefined;
      assertUsable();
      store.beginOutboxSettleEffect(outbox.id, workerId, normalizedStep);
      const value = await operation(settleIdempotencyKey(outbox.id, normalizedStep));
      assertUsable();
      store.completeOutboxSettleEffect(outbox.id, workerId, normalizedStep);
      completedSteps.add(normalizedStep);
      return value;
    }
  };
  return { context, remoteSucceeded: () => remoteSucceeded };
}

function settleIdempotencyKey(outboxId: string, step: string) {
  return `outbox:${outboxId}:settle:${step}`;
}

function requiredStep(value: unknown) {
  if (typeof value !== "string" || !value.trim()) throw new Error("settleStep is required.");
  return value.trim();
}
