import type { DatabaseSync } from "node:sqlite";
import {
  decodeOutboxDelivery,
  encodeOutboxDelivery
} from "../../packages/contracts/session/durableQueue.js";

type SqlRow = Record<string, unknown>;

export function migrateOutboxSchemaV3(database: DatabaseSync, now: number) {
  database.exec(`
    ALTER TABLE outbox ADD COLUMN delivery_partition TEXT NOT NULL DEFAULT 'legacy';
    ALTER TABLE outbox ADD COLUMN partition_sequence INTEGER NOT NULL DEFAULT 0
      CHECK (partition_sequence >= 0);
    ALTER TABLE outbox ADD COLUMN delivery_state TEXT NOT NULL DEFAULT 'pending'
      CHECK (delivery_state IN ('pending', 'sending', 'sent_remote', 'sent', 'dead', 'delivery_unknown'));
    ALTER TABLE outbox ADD COLUMN settle_attempts INTEGER NOT NULL DEFAULT 0 CHECK (settle_attempts >= 0);
    ALTER TABLE outbox ADD COLUMN transport_started_at INTEGER;
    ALTER TABLE outbox ADD COLUMN remote_receipt_json TEXT
      CHECK (remote_receipt_json IS NULL OR json_valid(remote_receipt_json));
    ALTER TABLE outbox ADD COLUMN remote_sent_at INTEGER;
    ALTER TABLE outbox ADD COLUMN settle_steps_json TEXT
      CHECK (settle_steps_json IS NULL OR json_valid(settle_steps_json));

    UPDATE outbox
    SET delivery_state = CASE status
      WHEN 'unknown' THEN 'delivery_unknown'
      WHEN 'sending' THEN 'delivery_unknown'
      ELSE status
    END,
    delivery_partition = CASE
      WHEN COALESCE(
        json_extract(payload_json, '$.payload.value.payload.incoming.transport'),
        json_extract(payload_json, '$.payload.incoming.transport')
      ) = 'web' THEN 'web'
      WHEN kind LIKE 'onebot.%' THEN COALESCE(
        NULLIF(TRIM(CAST(COALESCE(
          json_extract(payload_json, '$.payload.value.payload.incoming.accountId'),
          json_extract(payload_json, '$.payload.incoming.accountId')
        ) AS TEXT)), ''),
        'primary'
      )
      ELSE 'adapter:' || kind
    END;

    WITH ranked AS (
      SELECT id, ROW_NUMBER() OVER (
        PARTITION BY delivery_partition ORDER BY created_at, id
      ) AS partition_sequence
      FROM outbox
    )
    UPDATE outbox
    SET partition_sequence = (
      SELECT ranked.partition_sequence FROM ranked WHERE ranked.id = outbox.id
    );

    CREATE INDEX outbox_partition_claim_idx
      ON outbox(delivery_state, delivery_partition, partition_sequence, available_at, session_id, sequence);
    CREATE UNIQUE INDEX outbox_partition_sequence_idx
      ON outbox(delivery_partition, partition_sequence);
  `);

  const migratedSending = database.prepare(`
    SELECT * FROM outbox WHERE status = 'sending' ORDER BY session_id, sequence, id
  `).all() as SqlRow[];
  for (const row of migratedSending) {
    const id = String(row.id);
    const sessionId = String(row.session_id);
    const originTurnId = String(row.origin_turn_id);
    const dedupeKey = nullableText(row.dedupe_key);
    const encodedDelivery = encodeOutboxDelivery({
      outcome: "delivery_unknown",
      error: {
        code: "legacy_transport_migration_unknown",
        message: "Legacy transport state could not prove whether remote delivery completed."
      }
    }, {
      id,
      sessionId,
      occurredAt: now,
      correlationId: originTurnId,
      causationId: originTurnId,
      ...(dedupeKey ? { idempotencyKey: dedupeKey } : {})
    });
    decodeOutboxDelivery(encodedDelivery, null);
    database.prepare(`
      UPDATE outbox
      SET status = 'unknown', delivery_state = 'delivery_unknown',
          worker_id = NULL, lease_until = NULL, result_json = ?,
          error_json = NULL, finished_at = COALESCE(finished_at, ?)
      WHERE id = ? AND status = 'sending'
    `).run(encodedDelivery, now, id);
  }
  for (const sessionId of new Set(migratedSending.map((row) => String(row.session_id)))) {
    advanceTerminalPrefix(database, sessionId, now);
  }
}

export function migrateOutboxSchemaV4(database: DatabaseSync) {
  database.exec("ALTER TABLE outbox ADD COLUMN settle_started_step TEXT");
}

function advanceTerminalPrefix(database: DatabaseSync, sessionId: string, now: number) {
  while (true) {
    const session = database.prepare(`
      SELECT completed_outbox_sequence FROM sessions WHERE session_id = ?
    `).get(sessionId) as SqlRow | undefined;
    if (!session) return;
    const completedSequence = Number(session.completed_outbox_sequence);
    const next = database.prepare(`
      SELECT delivery_state FROM outbox WHERE session_id = ? AND sequence = ?
    `).get(sessionId, completedSequence + 1) as SqlRow | undefined;
    if (!next || !["sent", "dead", "delivery_unknown"].includes(String(next.delivery_state))) return;
    const updated = database.prepare(`
      UPDATE sessions
      SET completed_outbox_sequence = ?, updated_at = ?
      WHERE session_id = ? AND completed_outbox_sequence = ?
    `).run(completedSequence + 1, now, sessionId, completedSequence);
    if (Number(updated.changes) !== 1) {
      throw new Error(`Session ${sessionId} outbox cursor could not advance during migration.`);
    }
  }
}

function nullableText(value: unknown) {
  if (value == null) return undefined;
  const text = String(value).trim();
  return text || undefined;
}
