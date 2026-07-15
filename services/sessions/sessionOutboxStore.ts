import {
  decodeOutboxDelivery,
  decodeOutboxPayload,
  decodeOutboxRemoteReceipt,
  decodeOutboxSettleProgress,
  encodeOutboxDelivery,
  encodeOutboxPayload,
  encodeOutboxRemoteReceipt
} from "../../packages/contracts/session/durableQueue.js";
import {
  beginOutboxSettleEffect as persistOutboxSettleEffectStart,
  completeOutboxSettleEffect as persistOutboxSettleEffectCompletion,
  completeOutboxSettleStep as persistOutboxSettleStep,
  resolveUnknownSettle as persistUnknownSettleResolution,
  type OutboxSettleStoreBackend
} from "./outboxSettleStore.js";
import {
  migrateOutboxSchemaV3 as migrateOutboxDeliverySchema,
  migrateOutboxSchemaV4 as migrateOutboxSettleSchema
} from "./outboxSchemaMigration.js";
import { SessionToolJobStore } from "./sessionToolJobStore.js";
import {
  integerTimestamp,
  nullableNumber,
  nullableString,
  numberValue,
  optionalText,
  positiveInteger,
  requiredText
} from "./sessionStoreBackend.js";
import type {
  ClaimOptions,
  FinishOutboxInput,
  OutboxDraft,
  OutboxRecord,
  OutboxStatus,
  ResolveUnknownSettleInput,
  SqlRow,
  TurnRecord
} from "./sessionTypes.js";

export abstract class SessionOutboxStore extends SessionToolJobStore {
  claimNextOutbox(options: ClaimOptions): OutboxRecord | null {
    const workerId = requiredText(options.workerId, "workerId");
    const leaseMs = positiveInteger(options.leaseMs, this.defaultLeaseMs, "leaseMs");
    const sessionId = optionalText(options.sessionId);
    const deliveryPartition = options.deliveryPartition == null
      ? undefined
      : requiredDeliveryPartition(options.deliveryPartition, "deliveryPartition");
    const excludedDeliveryPartitions = normalizeExcludedPartitions(options.excludedDeliveryPartitions);
    const now = this.now();
    return this.transaction(() => {
      const row = this.database.prepare(`
        SELECT o.*
        FROM outbox o
        JOIN sessions s ON s.session_id = o.session_id
        WHERE o.delivery_state IN ('pending', 'sent_remote')
          AND o.available_at <= ?
          AND o.sequence = s.completed_outbox_sequence + 1
          AND NOT EXISTS (
            SELECT 1 FROM outbox earlier
            WHERE earlier.delivery_partition = o.delivery_partition
              AND earlier.partition_sequence < o.partition_sequence
              AND earlier.delivery_state NOT IN ('sent', 'dead', 'delivery_unknown')
          )
          AND (? IS NULL OR o.session_id = ?)
          AND (? IS NULL OR o.delivery_partition = ?)
          AND (
            o.delivery_state = 'sent_remote'
            OR NOT EXISTS (
              SELECT 1 FROM json_each(?) excluded
              WHERE excluded.value = o.delivery_partition
            )
          )
          AND (
            o.delivery_state = 'pending'
            OR o.worker_id IS NULL
            OR o.lease_until IS NULL
            OR o.lease_until <= ?
          )
        ORDER BY
          CASE o.delivery_state WHEN 'sent_remote' THEN 0 ELSE 1 END,
          o.available_at, o.created_at, o.session_id, o.sequence
        LIMIT 1
      `).get(
        now,
        sessionId ?? null,
        sessionId ?? null,
        deliveryPartition ?? null,
        deliveryPartition ?? null,
        JSON.stringify(excludedDeliveryPartitions),
        now
      ) as SqlRow | undefined;
      if (!row) return null;
      const outbox = mapOutbox(row);
      const updated = outbox.status === "pending"
        ? this.database.prepare(`
            UPDATE outbox
            SET status = 'sending', delivery_state = 'sending', attempts = attempts + 1,
                worker_id = ?, lease_until = ?, transport_started_at = NULL
            WHERE id = ? AND delivery_state = 'pending'
          `).run(workerId, now + leaseMs, outbox.id)
        : this.database.prepare(`
            UPDATE outbox
            SET settle_attempts = settle_attempts + 1,
                worker_id = ?, lease_until = ?
            WHERE id = ? AND delivery_state = 'sent_remote'
              AND (worker_id IS NULL OR lease_until IS NULL OR lease_until <= ?)
          `).run(workerId, now + leaseMs, outbox.id, now);
      return Number(updated.changes) === 1 ? this.requireOutbox(outbox.id) : null;
    });
  }

  renewOutboxLease(outboxId: string, workerId: string, leaseMs = this.defaultLeaseMs) {
    const now = this.now();
    const result = this.database.prepare(`
      UPDATE outbox SET lease_until = ?
      WHERE id = ? AND delivery_state IN ('sending', 'sent_remote') AND worker_id = ?
    `).run(now + positiveInteger(leaseMs, this.defaultLeaseMs, "leaseMs"), outboxId, workerId);
    return Number(result.changes) === 1;
  }

  markOutboxTransportStarted(outboxId: string, workerId: string) {
    const now = this.now();
    return this.transaction(() => {
      const outbox = this.requireOutbox(requiredText(outboxId, "outboxId"));
      if (outbox.status !== "sending") {
        throw new Error(`Outbox ${outbox.id} is ${outbox.status}, not sending.`);
      }
      this.assertWorker(outbox.workerId, requiredText(workerId, "workerId"), `outbox ${outbox.id}`);
      const updated = this.database.prepare(`
        UPDATE outbox SET transport_started_at = ?
        WHERE id = ? AND delivery_state = 'sending'
          AND worker_id = ? AND transport_started_at IS NULL
      `).run(now, outbox.id, workerId);
      if (Number(updated.changes) !== 1) {
        throw new Error(`Outbox ${outbox.id} transport was already started.`);
      }
      return this.requireOutbox(outbox.id);
    });
  }

  markOutboxRemoteSent(outboxId: string, workerId: string, receipt: unknown) {
    const now = this.now();
    return this.transaction(() => {
      const outbox = this.requireOutbox(requiredText(outboxId, "outboxId"));
      if (outbox.status === "sent_remote") {
        this.assertWorker(outbox.workerId, requiredText(workerId, "workerId"), `outbox ${outbox.id}`);
        return outbox;
      }
      if (outbox.status !== "sending" || outbox.transportStartedAt == null) {
        throw new Error(`Outbox ${outbox.id} transport has not started.`);
      }
      this.assertWorker(outbox.workerId, requiredText(workerId, "workerId"), `outbox ${outbox.id}`);
      const encodedReceipt = encodeOutboxRemoteReceipt(receipt, deliveryContext(outbox, now));
      const updated = this.database.prepare(`
        UPDATE outbox
        SET status = 'pending', delivery_state = 'sent_remote',
            remote_receipt_json = ?, remote_sent_at = ?
        WHERE id = ? AND delivery_state = 'sending' AND worker_id = ?
      `).run(encodedReceipt, now, outbox.id, workerId);
      if (Number(updated.changes) !== 1) {
        throw new Error(`Outbox ${outbox.id} remote receipt could not be recorded.`);
      }
      return this.requireOutbox(outbox.id);
    });
  }

  completeOutboxSettleStep(outboxId: string, workerId: string, step: string) {
    return persistOutboxSettleStep(this.outboxSettleBackend(), outboxId, workerId, step);
  }

  beginOutboxSettleEffect(outboxId: string, workerId: string, step: string) {
    return persistOutboxSettleEffectStart(this.outboxSettleBackend(), outboxId, workerId, step);
  }

  completeOutboxSettleEffect(outboxId: string, workerId: string, step: string) {
    return persistOutboxSettleEffectCompletion(this.outboxSettleBackend(), outboxId, workerId, step);
  }

  resolveUnknownSettle(input: ResolveUnknownSettleInput) {
    return persistUnknownSettleResolution(this.outboxSettleBackend(), input);
  }

  private outboxSettleBackend(): OutboxSettleStoreBackend {
    return {
      database: this.database,
      now: () => this.now(),
      transaction: (operation) => this.transaction(operation),
      requireOutbox: (id) => this.requireOutbox(id),
      assertWorker: (actual, expected, label) => this.assertWorker(actual, expected, label)
    };
  }

  finishOutbox(input: FinishOutboxInput): OutboxRecord {
    const now = this.now();
    return this.transaction(() => {
      const outbox = this.requireOutbox(input.outboxId);
      if (isTerminalOutboxStatus(outbox.status)) return outbox;
      if (outbox.status !== "sending" && outbox.status !== "sent_remote") {
        throw new Error(`Outbox ${outbox.id} is ${outbox.status}, not deliverable.`);
      }
      this.assertWorker(outbox.workerId, input.workerId, `outbox ${outbox.id}`);
      if (outbox.uncertainSettleStep && input.outcome !== "delivery_unknown") {
        throw new Error(`Outbox ${outbox.id} settle effect ${outbox.uncertainSettleStep} is uncertain.`);
      }

      if (input.outcome === "retry") {
        const encodedDelivery = encodeOutboxDelivery({
          outcome: "retry",
          ...(input.error !== undefined ? { error: input.error } : {})
        }, {
          id: outbox.id,
          sessionId: outbox.sessionId,
          occurredAt: now,
          correlationId: outbox.originTurnId,
          causationId: outbox.originTurnId,
          ...(outbox.dedupeKey ? { idempotencyKey: outbox.dedupeKey } : {})
        });
        const retryState = outbox.status === "sent_remote" ? "sent_remote" : "pending";
        this.database.prepare(`
          UPDATE outbox
          SET status = 'pending', delivery_state = ?, worker_id = NULL, lease_until = NULL,
              result_json = ?, error_json = NULL, available_at = ?
          WHERE id = ? AND delivery_state = ?
        `).run(
          retryState,
          encodedDelivery,
          integerTimestamp(input.availableAt, now, "availableAt"),
          outbox.id,
          outbox.status
        );
        return this.requireOutbox(outbox.id);
      }

      const session = this.requireSession(outbox.sessionId);
      if (outbox.sequence !== session.completedOutboxSequence + 1) {
        throw new Error(`Outbox ${outbox.id} is not the head of session ${outbox.sessionId}.`);
      }
      const encodedDelivery = encodeOutboxDelivery({
        outcome: input.outcome,
        ...(input.result !== undefined ? { result: input.result } : {}),
        ...(input.error !== undefined ? { error: input.error } : {})
      }, {
        id: outbox.id,
        sessionId: outbox.sessionId,
        occurredAt: now,
        correlationId: outbox.originTurnId,
        causationId: outbox.originTurnId,
        ...(outbox.dedupeKey ? { idempotencyKey: outbox.dedupeKey } : {})
      });
      const unknownSettle = input.outcome === "delivery_unknown" && Boolean(outbox.uncertainSettleStep);
      const storedStatus = input.outcome === "delivery_unknown"
        ? (unknownSettle ? "sending" : "unknown")
        : input.outcome;
      this.database.prepare(`
        UPDATE outbox
        SET status = ?, delivery_state = ?, worker_id = NULL, lease_until = NULL,
            result_json = ?, error_json = NULL, sent_at = ?, finished_at = ?
        WHERE id = ? AND delivery_state IN ('sending', 'sent_remote')
      `).run(
        storedStatus,
        input.outcome,
        encodedDelivery,
        input.outcome === "sent" ? now : null,
        now,
        outbox.id
      );
      if (unknownSettle) return this.requireOutbox(outbox.id);
      this.database.prepare(`
        UPDATE sessions
        SET completed_outbox_sequence = ?, updated_at = ?
        WHERE session_id = ? AND completed_outbox_sequence = ?
      `).run(outbox.sequence, now, outbox.sessionId, outbox.sequence - 1);
      return this.requireOutbox(outbox.id);
    });
  }

  getOutbox(id: string) {
    const row = this.database.prepare("SELECT * FROM outbox WHERE id = ?")
      .get(id) as SqlRow | undefined;
    return row ? mapOutbox(row) : undefined;
  }

  listOutbox(sessionId: string) {
    return (this.database.prepare(`
      SELECT * FROM outbox WHERE session_id = ? ORDER BY sequence
    `).all(sessionId) as SqlRow[]).map(mapOutbox);
  }

  protected createOutboxSchema() {
    this.database.exec(`
      CREATE TABLE outbox (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL CHECK (sequence > 0),
        origin_turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        dedupe_key TEXT,
        payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
        status TEXT NOT NULL CHECK (status IN ('pending', 'sending', 'sent', 'dead', 'unknown')),
        attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        available_at INTEGER NOT NULL,
        worker_id TEXT,
        lease_until INTEGER,
        result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
        error_json TEXT CHECK (error_json IS NULL OR json_valid(error_json)),
        created_at INTEGER NOT NULL,
        sent_at INTEGER,
        finished_at INTEGER,
        UNIQUE (session_id, sequence),
        UNIQUE (session_id, dedupe_key)
      ) STRICT;

      CREATE INDEX outbox_claim_idx ON outbox(status, available_at, session_id, sequence);
      CREATE INDEX outbox_lease_idx ON outbox(status, lease_until);
    `);
  }

  protected insertOutbox(turn: TurnRecord, draft: OutboxDraft, now: number) {
    const id = this.nextId();
    const sequence = this.allocateOutboxSequence(turn.sessionId, now);
    const kind = requiredText(draft.kind, "outbox.kind");
    const deliveryPartition = draft.deliveryPartition == null
      ? inferredDeliveryPartition(kind, draft.payload)
      : requiredDeliveryPartition(draft.deliveryPartition, "outbox.deliveryPartition");
    const partitionSequence = this.allocateDeliveryPartitionSequence(deliveryPartition);
    const dedupeKey = optionalText(draft.dedupeKey);
    const encodedPayload = encodeOutboxPayload(draft.payload, kind, {
      id,
      sessionId: turn.sessionId,
      occurredAt: now,
      correlationId: turn.id,
      causationId: turn.eventId,
      ...(dedupeKey ? { idempotencyKey: dedupeKey } : {})
    });
    this.database.prepare(`
      INSERT INTO outbox (
        id, session_id, sequence, origin_turn_id, kind, dedupe_key,
        payload_json, status, delivery_partition, partition_sequence, delivery_state,
        attempts, settle_attempts, available_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, 'pending', 0, 0, ?, ?)
    `).run(
      id,
      turn.sessionId,
      sequence,
      turn.id,
      kind,
      dedupeKey ?? null,
      encodedPayload,
      deliveryPartition,
      partitionSequence,
      integerTimestamp(draft.availableAt, now, "outbox.availableAt"),
      now
    );
    return this.requireOutbox(id);
  }

  protected requireOutbox(id: string) {
    const value = this.getOutbox(id);
    if (!value) throw new Error(`Outbox item not found: ${id}`);
    return value;
  }

  protected listOutboxForTurn(turnId: string) {
    return (this.database.prepare(`
      SELECT * FROM outbox WHERE origin_turn_id = ? ORDER BY sequence
    `).all(turnId) as SqlRow[]).map(mapOutbox);
  }

  protected recoverOutboxLeases(all: boolean, now: number) {
    const candidates = this.database.prepare(`
      SELECT * FROM outbox
      WHERE delivery_state IN ('sending', 'sent_remote')
        AND (? = 1 OR lease_until IS NULL OR lease_until <= ?)
      ORDER BY created_at, id
    `).all(all ? 1 : 0, now) as SqlRow[];
    let recovered = 0;
    for (const row of candidates) {
      const outbox = mapOutbox(row);
      if (outbox.status === "sent_remote") {
        if (outbox.uncertainSettleStep) {
          const encodedDelivery = encodeOutboxDelivery({
            outcome: "delivery_unknown",
            error: {
              code: "settle_effect_recovered_unknown",
              message: `Settle effect ${outbox.uncertainSettleStep} may have been applied before recovery.`
            }
          }, deliveryContext(outbox, now));
          const result = this.database.prepare(`
            UPDATE outbox
            SET status = 'sending', delivery_state = 'delivery_unknown',
                worker_id = NULL, lease_until = NULL, result_json = ?,
                error_json = NULL, finished_at = ?
            WHERE id = ? AND delivery_state = 'sent_remote'
              AND settle_started_step = ?
          `).run(encodedDelivery, now, outbox.id, outbox.uncertainSettleStep);
          recovered += Number(result.changes);
          continue;
        }
        const result = this.database.prepare(`
          UPDATE outbox
          SET status = 'pending', worker_id = NULL, lease_until = NULL, available_at = ?
          WHERE id = ? AND delivery_state = 'sent_remote'
        `).run(now, outbox.id);
        recovered += Number(result.changes);
        continue;
      }
      if (outbox.transportStartedAt == null) {
        const result = this.database.prepare(`
          UPDATE outbox
          SET status = 'pending', delivery_state = 'pending',
              worker_id = NULL, lease_until = NULL, available_at = ?
          WHERE id = ? AND delivery_state = 'sending'
        `).run(now, outbox.id);
        recovered += Number(result.changes);
        continue;
      }
      const encodedDelivery = encodeOutboxDelivery({
        outcome: "delivery_unknown",
        error: { code: "delivery_recovered_unknown", message: "Transport result was unknown after recovery." }
      }, deliveryContext(outbox, now));
      const result = this.database.prepare(`
        UPDATE outbox
        SET status = 'unknown', delivery_state = 'delivery_unknown',
            worker_id = NULL, lease_until = NULL, result_json = ?, error_json = NULL,
            finished_at = ?
        WHERE id = ? AND delivery_state = 'sending'
      `).run(encodedDelivery, now, outbox.id);
      if (Number(result.changes) !== 1) continue;
      this.advanceOutboxCursor(outbox, now);
      recovered += 1;
    }
    return recovered;
  }

  protected migrateOutboxSchemaV3() {
    migrateOutboxDeliverySchema(this.database, this.now());
  }

  protected migrateOutboxSchemaV4() {
    migrateOutboxSettleSchema(this.database);
  }

  private advanceOutboxCursor(outbox: OutboxRecord, now: number) {
    const session = this.requireSession(outbox.sessionId);
    if (outbox.sequence !== session.completedOutboxSequence + 1) {
      throw new Error(`Outbox ${outbox.id} is not the head of session ${outbox.sessionId}.`);
    }
    const result = this.database.prepare(`
      UPDATE sessions
      SET completed_outbox_sequence = ?, updated_at = ?
      WHERE session_id = ? AND completed_outbox_sequence = ?
    `).run(outbox.sequence, now, outbox.sessionId, outbox.sequence - 1);
    if (Number(result.changes) !== 1) {
      throw new Error(`Session ${outbox.sessionId} outbox cursor could not advance.`);
    }
  }

  private allocateDeliveryPartitionSequence(deliveryPartition: string) {
    const row = this.database.prepare(`
      SELECT COALESCE(MAX(partition_sequence), 0) + 1 AS sequence
      FROM outbox WHERE delivery_partition = ?
    `).get(deliveryPartition) as SqlRow;
    return numberValue(row.sequence);
  }
}

function mapOutbox(row: SqlRow): OutboxRecord {
  const delivery = decodeOutboxDelivery(row.result_json, row.error_json);
  return {
    id: String(row.id),
    sessionId: String(row.session_id),
    sequence: numberValue(row.sequence),
    originTurnId: String(row.origin_turn_id),
    kind: String(row.kind),
    dedupeKey: nullableString(row.dedupe_key),
    payload: decodeOutboxPayload(row.payload_json),
    deliveryPartition: String(row.delivery_partition),
    partitionSequence: numberValue(row.partition_sequence),
    status: String(row.delivery_state) as OutboxStatus,
    attempts: numberValue(row.attempts),
    settleAttempts: numberValue(row.settle_attempts),
    availableAt: numberValue(row.available_at),
    workerId: nullableString(row.worker_id),
    leaseUntil: nullableNumber(row.lease_until),
    result: delivery.result,
    error: delivery.error,
    remoteReceipt: decodeOutboxRemoteReceipt(row.remote_receipt_json),
    completedSettleSteps: decodeOutboxSettleProgress(row.settle_steps_json),
    uncertainSettleStep: nullableString(row.settle_started_step),
    createdAt: numberValue(row.created_at),
    transportStartedAt: nullableNumber(row.transport_started_at),
    remoteSentAt: nullableNumber(row.remote_sent_at),
    sentAt: nullableNumber(row.sent_at),
    finishedAt: nullableNumber(row.finished_at)
  };
}

function isTerminalOutboxStatus(status: OutboxStatus) {
  return status === "sent" || status === "dead" || status === "delivery_unknown";
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

function normalizeExcludedPartitions(value: readonly string[] | undefined) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > 1_000) {
    throw new Error("excludedDeliveryPartitions must be an array with at most 1000 items.");
  }
  return [...new Set(value.map((partition, index) => requiredDeliveryPartition(
    partition,
    `excludedDeliveryPartitions[${index}]`
  )))];
}

function requiredDeliveryPartition(value: unknown, label: string) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required.`);
  const partition = value.trim();
  if (partition.length > 128) throw new Error(`${label} must contain at most 128 characters.`);
  return partition;
}

function inferredDeliveryPartition(kind: string, payload: unknown) {
  const runtimePayload = record(record(payload).payload);
  const incoming = record(runtimePayload.incoming);
  if (incoming.transport === "web") return "web";
  if (kind.startsWith("onebot.")) {
    return requiredDeliveryPartition(incoming.accountId ?? "primary", "outbox.deliveryPartition");
  }
  return requiredDeliveryPartition(`adapter:${kind}`, "outbox.deliveryPartition");
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
