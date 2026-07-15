import type { DatabaseSync } from "node:sqlite";
import { encodeOutboxSettleProgress } from "../../packages/contracts/session/durableQueue.js";
import { requiredText } from "./sessionStoreBackend.js";
import type { OutboxRecord, ResolveUnknownSettleInput } from "./sessionTypes.js";

export interface OutboxSettleStoreBackend {
  database: DatabaseSync;
  now(): number;
  transaction<T>(operation: () => T): T;
  requireOutbox(id: string): OutboxRecord;
  assertWorker(actual: string | undefined, expected: string, label: string): void;
}

export function completeOutboxSettleStep(
  backend: OutboxSettleStoreBackend,
  outboxId: string,
  workerId: string,
  step: string
) {
  const normalizedStep = requiredSettleStep(step);
  const now = backend.now();
  return backend.transaction(() => {
    const outbox = backend.requireOutbox(requiredText(outboxId, "outboxId"));
    assertSentRemote(backend, outbox, workerId);
    if (outbox.completedSettleSteps.includes(normalizedStep)) return outbox;
    const completedSteps = [...outbox.completedSettleSteps, normalizedStep];
    const encodedProgress = encodeOutboxSettleProgress(completedSteps, deliveryContext(outbox, now));
    const updated = backend.database.prepare(`
      UPDATE outbox SET settle_steps_json = ?
      WHERE id = ? AND delivery_state = 'sent_remote' AND worker_id = ?
    `).run(encodedProgress, outbox.id, workerId);
    if (Number(updated.changes) !== 1) {
      throw new Error(`Outbox ${outbox.id} settle progress could not be recorded.`);
    }
    return backend.requireOutbox(outbox.id);
  });
}

export function beginOutboxSettleEffect(
  backend: OutboxSettleStoreBackend,
  outboxId: string,
  workerId: string,
  step: string
) {
  const normalizedStep = requiredSettleStep(step);
  return backend.transaction(() => {
    const outbox = backend.requireOutbox(requiredText(outboxId, "outboxId"));
    assertSentRemote(backend, outbox, workerId);
    if (outbox.completedSettleSteps.includes(normalizedStep)) return outbox;
    if (outbox.uncertainSettleStep) {
      throw new Error(`Outbox ${outbox.id} settle effect ${outbox.uncertainSettleStep} is already in progress.`);
    }
    const updated = backend.database.prepare(`
      UPDATE outbox SET settle_started_step = ?
      WHERE id = ? AND delivery_state = 'sent_remote'
        AND worker_id = ? AND settle_started_step IS NULL
    `).run(normalizedStep, outbox.id, workerId);
    if (Number(updated.changes) !== 1) {
      throw new Error(`Outbox ${outbox.id} settle effect could not be started.`);
    }
    return backend.requireOutbox(outbox.id);
  });
}

export function completeOutboxSettleEffect(
  backend: OutboxSettleStoreBackend,
  outboxId: string,
  workerId: string,
  step: string
) {
  const normalizedStep = requiredSettleStep(step);
  const now = backend.now();
  return backend.transaction(() => {
    const outbox = backend.requireOutbox(requiredText(outboxId, "outboxId"));
    assertSentRemote(backend, outbox, workerId);
    if (outbox.completedSettleSteps.includes(normalizedStep) && !outbox.uncertainSettleStep) return outbox;
    if (outbox.uncertainSettleStep !== normalizedStep) {
      throw new Error(`Outbox ${outbox.id} settle effect ${normalizedStep} was not started.`);
    }
    const completedSteps = [...outbox.completedSettleSteps, normalizedStep];
    const encodedProgress = encodeOutboxSettleProgress(completedSteps, deliveryContext(outbox, now));
    const updated = backend.database.prepare(`
      UPDATE outbox SET settle_steps_json = ?, settle_started_step = NULL
      WHERE id = ? AND delivery_state = 'sent_remote'
        AND worker_id = ? AND settle_started_step = ?
    `).run(encodedProgress, outbox.id, workerId, normalizedStep);
    if (Number(updated.changes) !== 1) {
      throw new Error(`Outbox ${outbox.id} settle effect could not be completed.`);
    }
    return backend.requireOutbox(outbox.id);
  });
}

export function resolveUnknownSettle(
  backend: OutboxSettleStoreBackend,
  input: ResolveUnknownSettleInput
) {
  const normalizedStep = requiredSettleStep(input.settleStep);
  if (input.confirmed !== "applied" && input.confirmed !== "not_applied") {
    throw new Error("confirmed must be applied or not_applied.");
  }
  const now = backend.now();
  return backend.transaction(() => {
    const outbox = backend.requireOutbox(requiredText(input.outboxId, "outboxId"));
    if (outbox.status !== "delivery_unknown" || !outbox.uncertainSettleStep) {
      throw new Error(`Outbox ${outbox.id} does not have an unknown settle effect.`);
    }
    if (outbox.uncertainSettleStep !== normalizedStep) {
      throw new Error(`Outbox ${outbox.id} unknown settle effect is ${outbox.uncertainSettleStep}.`);
    }
    const completedSteps = input.confirmed === "applied" && !outbox.completedSettleSteps.includes(normalizedStep)
      ? [...outbox.completedSettleSteps, normalizedStep]
      : outbox.completedSettleSteps;
    const encodedProgress = completedSteps.length
      ? encodeOutboxSettleProgress(completedSteps, deliveryContext(outbox, now))
      : null;
    const updated = backend.database.prepare(`
      UPDATE outbox
      SET status = 'pending', delivery_state = 'sent_remote',
          settle_steps_json = ?, settle_started_step = NULL,
          worker_id = NULL, lease_until = NULL, result_json = NULL,
          error_json = NULL, available_at = ?, finished_at = NULL
      WHERE id = ? AND delivery_state = 'delivery_unknown'
        AND settle_started_step = ?
    `).run(encodedProgress, now, outbox.id, normalizedStep);
    if (Number(updated.changes) !== 1) {
      throw new Error(`Outbox ${outbox.id} unknown settle effect could not be resolved.`);
    }
    return backend.requireOutbox(outbox.id);
  });
}

function assertSentRemote(
  backend: OutboxSettleStoreBackend,
  outbox: OutboxRecord,
  workerId: string
) {
  if (outbox.status !== "sent_remote") {
    throw new Error(`Outbox ${outbox.id} is ${outbox.status}, not sent_remote.`);
  }
  backend.assertWorker(outbox.workerId, requiredText(workerId, "workerId"), `outbox ${outbox.id}`);
}

function requiredSettleStep(value: unknown) {
  if (typeof value !== "string" || !value.trim()) throw new Error("settleStep is required.");
  const step = value.trim();
  if (step.length > 128) throw new Error("settleStep must contain at most 128 characters.");
  return step;
}

function deliveryContext(outbox: OutboxRecord, occurredAt: number) {
  return {
    id: outbox.id,
    sessionId: outbox.sessionId,
    occurredAt,
    correlationId: outbox.originTurnId,
    causationId: outbox.originTurnId,
    ...(outbox.dedupeKey ? { idempotencyKey: outbox.dedupeKey } : {})
  };
}
