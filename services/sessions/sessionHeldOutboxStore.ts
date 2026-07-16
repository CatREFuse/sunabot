import type { DatabaseSync } from "node:sqlite";
import {
  decodeAssistantReply,
  SYSTEM_CONFIG_NEUTRAL_CONFIRMATION_TEXT,
  type AssistantReplyOutboxEnvelope,
  type ReplyGateSnapshotV1
} from "../../packages/contracts/session/runtimeMessages.js";
import {
  decodeOutboxPayload,
  encodeOutboxPayload
} from "../../packages/contracts/session/durableQueue.js";
import type {
  AppendHeldTurnOutboxInput,
  AppendTurnOutboxResult,
  HeldOutboxAppendOptions,
  HeldOutboxLineageEntryV1,
  HeldOutboxProvenanceV1,
  HeldOutboxReleaseProvenanceV1,
  HeldOutboxReplyGateV1,
  OutboxDraft,
  OutboxHoldState,
  OutboxRecord,
  ReplayUnknownOutboxInput,
  ReleaseHeldOutboxInput,
  SessionEventRecord,
  SqlRow,
  TurnRecord
} from "./sessionTypes.js";
import { requiredText } from "./sessionStoreBackend.js";

const MAX_PROVENANCE_JSON_LENGTH = 8_192;
const MAX_HELD_LINEAGE = 8;
const MUTATION_FINGERPRINT_PATTERN = /^sha256:[a-f0-9]{64}$/u;

export interface HeldOutboxInsertMetadata {
  holdState: Exclude<OutboxHoldState, "none">;
  mutationFingerprint: string;
  holdProvenanceJson: string;
  releaseProvenanceJson?: string;
}

export interface HeldOutboxStoreBackend {
  database: DatabaseSync;
  now(): number;
  transaction<T>(operation: () => T): T;
  requireOutbox(id: string): OutboxRecord;
}

interface HeldTurnOutboxBackend extends HeldOutboxStoreBackend {
  requireTurn(id: string): TurnRecord;
  requireEvent(id: string): SessionEventRecord;
  assertWorker(actual: string | undefined, expected: string, label: string): void;
  assertHeadEvent(event: SessionEventRecord): void;
  insertOutbox(
    turn: TurnRecord,
    draft: OutboxDraft,
    now: number,
    held?: HeldOutboxInsertMetadata
  ): OutboxRecord;
}

export function appendHeldTurnOutbox(
  backend: HeldTurnOutboxBackend,
  input: AppendHeldTurnOutboxInput
): AppendTurnOutboxResult {
  const turnId = requiredText(input.turnId, "turnId");
  const workerId = requiredText(input.workerId, "workerId");
  const dedupeKey = requiredText(input.dedupeKey, "dedupeKey");
  const dedupeFingerprint = requiredText(input.draft.dedupeFingerprint, "outbox.dedupeFingerprint");
  const persistedDedupeKey = `${dedupeKey}:${dedupeFingerprint}`;
  const held = heldOutboxInsertMetadata(input.draft, input.hold);
  const now = backend.now();

  return backend.transaction(() => {
    const turn = backend.requireTurn(turnId);
    if (turn.status !== "running") {
      throw new Error(`Turn ${turn.id} is ${turn.status}, not running.`);
    }
    backend.assertWorker(turn.workerId, workerId, `turn ${turn.id}`);
    const event = backend.requireEvent(turn.eventId);
    backend.assertHeadEvent(event);

    const existingRow = backend.database.prepare(`
      SELECT id FROM outbox
      WHERE session_id = ?
        AND (dedupe_key = ? OR (
          instr(dedupe_key, ?) = 1
          AND substr(dedupe_key, length(?) + 1, 1) = ':'
        ))
    `).get(turn.sessionId, dedupeKey, dedupeKey, dedupeKey) as SqlRow | undefined;
    if (existingRow) {
      const existing = backend.requireOutbox(String(existingRow.id));
      const originTurn = backend.requireTurn(existing.originTurnId);
      if (originTurn.eventId !== event.id) {
        throw new Error(
          `Outbox dedupe key ${dedupeKey} belongs to event ${originTurn.eventId}, not ${event.id}.`
        );
      }
      if (existing.dedupeKey !== persistedDedupeKey) {
        throw new Error(`Outbox dedupe fingerprint changed for ${dedupeKey}.`);
      }
      if (existing.mutationFingerprint !== held.mutationFingerprint) {
        throw new Error(`Held outbox mutation fingerprint changed for ${dedupeKey}.`);
      }
      if (existing.holdState === "none" ||
        JSON.stringify(existing.holdProvenance) !== held.holdProvenanceJson) {
        throw new Error(`Held outbox provenance changed for ${dedupeKey}.`);
      }
      return { outbox: existing, inserted: false };
    }

    return {
      outbox: backend.insertOutbox(
        turn,
        { ...input.draft, dedupeKey: persistedDedupeKey },
        now,
        held
      ),
      inserted: true
    };
  });
}

export function replayUnknownOutbox(
  backend: Pick<
    HeldTurnOutboxBackend,
    "database" | "now" | "transaction" | "requireOutbox" | "requireTurn" | "insertOutbox"
  >,
  input: ReplayUnknownOutboxInput
) {
  if (input.confirmedNotSent !== true) {
    throw new Error("confirmedNotSent must be true before replaying delivery_unknown.");
  }
  const now = backend.now();
  return backend.transaction(() => {
    const outbox = backend.requireOutbox(requiredText(input.outboxId, "outboxId"));
    if (outbox.status !== "delivery_unknown") {
      throw new Error(`Outbox ${outbox.id} is ${outbox.status}, not delivery_unknown.`);
    }
    if (outbox.uncertainSettleStep) {
      throw new Error(`Outbox ${outbox.id} has an unknown settle effect and cannot be replayed.`);
    }
    if (outbox.holdState === "held") {
      throw new Error(`Held outbox ${outbox.id} cannot be replayed before release.`);
    }
    if (outbox.holdState === "released" || outbox.holdState === "fallback_released") {
      const held = replayedHeldOutboxInsertMetadata(outbox);
      const replayDedupeKey = `outbox-replay:${outbox.id}:${held.mutationFingerprint}`;
      const existingRow = backend.database.prepare(`
        SELECT id FROM outbox WHERE dedupe_key = ? ORDER BY created_at, id LIMIT 1
      `).get(replayDedupeKey) as SqlRow | undefined;
      if (existingRow) {
        const existing = backend.requireOutbox(String(existingRow.id));
        if (
          existing.sessionId !== outbox.sessionId ||
          existing.originTurnId !== outbox.originTurnId ||
          existing.kind !== outbox.kind ||
          existing.deliveryPartition !== outbox.deliveryPartition ||
          existing.dedupeKey !== replayDedupeKey ||
          existing.holdState !== held.holdState ||
          existing.mutationFingerprint !== held.mutationFingerprint ||
          JSON.stringify(existing.payload) !== JSON.stringify(outbox.payload) ||
          JSON.stringify(existing.holdProvenance) !== held.holdProvenanceJson ||
          JSON.stringify(existing.releaseProvenance) !== held.releaseProvenanceJson
        ) {
          throw new Error(`Held outbox replay ${replayDedupeKey} conflicts with its original row.`);
        }
        return existing;
      }
      return backend.insertOutbox(backend.requireTurn(outbox.originTurnId), {
        kind: outbox.kind,
        payload: outbox.payload,
        deliveryPartition: outbox.deliveryPartition,
        dedupeKey: replayDedupeKey
      }, now, held);
    }
    return backend.insertOutbox(backend.requireTurn(outbox.originTurnId), {
      kind: outbox.kind,
      payload: outbox.payload,
      deliveryPartition: outbox.deliveryPartition
    }, now);
  });
}

export function heldOutboxInsertMetadata(
  draft: OutboxDraft,
  options: HeldOutboxAppendOptions
): HeldOutboxInsertMetadata {
  const mutationFingerprint = requiredMutationFingerprint(options.mutationFingerprint);
  if (draft.kind !== "onebot.reply") {
    throw new Error("Held system_config confirmation must use onebot.reply.");
  }
  const payload = decodeAssistantReply(draft.payload);
  const originalReplyGate = readReplyGate(options.originalReplyGate, "originalReplyGate");
  if (!sameReplyGate(payload.replyGate, originalReplyGate)) {
    throw new Error("Held system_config confirmation reply gate does not match its payload.");
  }
  if (
    payload.incoming.transport === "web" ||
    payload.incoming.scope !== "private" ||
    payload.incoming.groupId != null ||
    payload.isAdmin !== true ||
    payload.messageOrigin !== "text" ||
    payload.toolNames?.length !== 1 ||
    payload.toolNames[0] !== "system_config"
  ) {
    throw new Error("Held system_config confirmation payload is not an authorized private reply.");
  }
  if (options.semantics !== "system_config_confirmation") {
    throw new Error("Held outbox semantics are invalid.");
  }
  if (options.releasePolicy !== "unchanged" && options.releasePolicy !== "private_scope_plus_one") {
    throw new Error("Held outbox release policy is invalid.");
  }
  const marked = payload.deliverySemantics === "system_config_confirmation";
  if (marked !== (options.releasePolicy === "private_scope_plus_one")) {
    throw new Error("Held outbox delivery marker does not match its release policy.");
  }
  const provenance: HeldOutboxProvenanceV1 = {
    schemaVersion: 1,
    semantics: "system_config_confirmation",
    originalReplyGate,
    releasePolicy: options.releasePolicy,
    lineage: []
  };
  return {
    holdState: "held",
    mutationFingerprint,
    holdProvenanceJson: encodeProvenance(provenance)
  };
}

export function releaseHeldOutbox(
  backend: HeldOutboxStoreBackend,
  input: ReleaseHeldOutboxInput,
  outcome: "released" | "fallback_released"
) {
  const outboxId = requiredBoundedString(input.outboxId, "outboxId", 128);
  const mutationFingerprint = requiredMutationFingerprint(input.mutationFingerprint);
  const replyGate = readReplyGate(input.replyGate, "replyGate");
  return backend.transaction(() => releaseHeldOutboxInTransaction(
    backend,
    { outboxId, mutationFingerprint, replyGate },
    outcome
  ));
}

export function releaseHeldOutboxInTransaction(
  backend: HeldOutboxStoreBackend,
  input: ReleaseHeldOutboxInput,
  outcome: "released" | "fallback_released"
) {
  const mutationFingerprint = requiredMutationFingerprint(input.mutationFingerprint);
  const replyGate = readReplyGate(input.replyGate, "replyGate");
  const outbox = backend.requireOutbox(input.outboxId);
  assertHeldMutation(outbox, mutationFingerprint);
  if (outbox.holdState === outcome) {
    assertSameReleaseProvenance(outbox, outcome, replyGate);
    return outbox;
  }
  if (outbox.holdState !== "held") {
    throw new Error(`Held outbox ${outbox.id} is ${outbox.holdState}, not held.`);
  }
  const hold = requireHoldProvenance(outbox);
  assertReleaseGate(hold, replyGate, outcome === "fallback_released");
  const now = backend.now();
  const release: HeldOutboxReleaseProvenanceV1 = {
    schemaVersion: 1,
    outcome,
    replyGate,
    releasedAt: now
  };
  const neutralPayload = outcome === "fallback_released"
    ? neutralizeSystemConfigConfirmation(outbox.payload)
    : undefined;
  const encodedPayload = neutralPayload === undefined
    ? undefined
    : encodeOutboxPayload(neutralPayload, outbox.kind, {
        id: outbox.id,
        sessionId: outbox.sessionId,
        occurredAt: now,
        correlationId: outbox.originTurnId,
        causationId: outbox.originTurnId,
        ...(outbox.dedupeKey ? { idempotencyKey: outbox.dedupeKey } : {})
      });
  const updated = backend.database.prepare(`
    UPDATE outbox
    SET hold_state = ?, release_provenance_json = ?,
        payload_json = COALESCE(?, payload_json)
    WHERE id = ? AND hold_state = 'held' AND mutation_fingerprint = ?
  `).run(
    outcome,
    encodeProvenance(release),
    encodedPayload ?? null,
    outbox.id,
    mutationFingerprint
  );
  if (Number(updated.changes) !== 1) {
    throw new Error(`Held outbox ${outbox.id} could not be released.`);
  }
  return backend.requireOutbox(outbox.id);
}

export function decodeHeldOutboxMetadata(row: SqlRow): Pick<
  OutboxRecord,
  "holdState" | "mutationFingerprint" | "holdProvenance" | "releaseProvenance"
> {
  const holdState = readHoldState(row.hold_state);
  const mutationFingerprint = row.mutation_fingerprint == null
    ? undefined
    : requiredMutationFingerprint(row.mutation_fingerprint);
  const holdProvenance = row.hold_provenance_json == null
    ? undefined
    : decodeHoldProvenance(row.hold_provenance_json);
  const releaseProvenance = row.release_provenance_json == null
    ? undefined
    : decodeReleaseProvenance(row.release_provenance_json);
  if (holdState === "none") {
    if (mutationFingerprint || holdProvenance || releaseProvenance) {
      throw new Error("Ordinary outbox contains held provenance.");
    }
  } else if (holdState === "held") {
    if (!mutationFingerprint || !holdProvenance || releaseProvenance) {
      throw new Error("Held outbox provenance is incomplete.");
    }
  } else if (!mutationFingerprint || !holdProvenance || !releaseProvenance ||
    releaseProvenance.outcome !== holdState) {
    throw new Error("Released held outbox provenance is incomplete or inconsistent.");
  }
  return {
    holdState,
    ...(mutationFingerprint ? { mutationFingerprint } : {}),
    ...(holdProvenance ? { holdProvenance } : {}),
    ...(releaseProvenance ? { releaseProvenance } : {})
  };
}

export function encodeHeldOutboxProvenance(value: HeldOutboxProvenanceV1) {
  return encodeProvenance(decodeHoldProvenance(JSON.stringify(value)));
}

export function appendHeldLineage(
  provenance: HeldOutboxProvenanceV1,
  source: Pick<OutboxRecord, "id" | "mutationFingerprint" | "holdState">
) {
  if (provenance.lineage.length >= MAX_HELD_LINEAGE) {
    throw new Error("Held outbox replay lineage exceeds its maximum depth.");
  }
  if (!source.mutationFingerprint ||
    (source.holdState !== "released" && source.holdState !== "fallback_released")) {
    throw new Error("Held outbox replay source is not released.");
  }
  const entry: HeldOutboxLineageEntryV1 = {
    outboxId: requiredBoundedString(source.id, "lineage.outboxId", 128),
    mutationFingerprint: requiredMutationFingerprint(source.mutationFingerprint),
    holdState: source.holdState
  };
  return {
    ...provenance,
    lineage: [...provenance.lineage, entry]
  } satisfies HeldOutboxProvenanceV1;
}

export function replayedHeldOutboxInsertMetadata(source: OutboxRecord): HeldOutboxInsertMetadata {
  if ((source.holdState !== "released" && source.holdState !== "fallback_released") ||
    !source.mutationFingerprint || !source.holdProvenance || !source.releaseProvenance ||
    source.releaseProvenance.outcome !== source.holdState) {
    throw new Error(`Outbox ${source.id} does not contain replayable held provenance.`);
  }
  const provenance = appendHeldLineage(source.holdProvenance, source);
  return {
    holdState: source.holdState,
    mutationFingerprint: source.mutationFingerprint,
    holdProvenanceJson: encodeHeldOutboxProvenance(provenance),
    releaseProvenanceJson: encodeProvenance(source.releaseProvenance)
  };
}

function neutralizeSystemConfigConfirmation(value: unknown): AssistantReplyOutboxEnvelope {
  const decodedOutbox = decodeOutboxPayload(value);
  const payload = decodeAssistantReply(decodedOutbox);
  const envelope = record(decodedOutbox);
  if (envelope.schemaVersion !== 1 || envelope.type !== "runtime.assistant_reply") {
    throw new Error("Held system_config confirmation must use the canonical reply envelope.");
  }
  const rawPayload = record(envelope.payload);
  const { deliverySemantics: _deliverySemantics, ...payloadWithoutSuccessMarker } = rawPayload;
  return {
    ...(structuredClone(envelope) as unknown as AssistantReplyOutboxEnvelope),
    payload: {
      ...payloadWithoutSuccessMarker,
      type: "assistant_reply",
      incoming: payload.incoming,
      text: SYSTEM_CONFIG_NEUTRAL_CONFIRMATION_TEXT,
      generatedImages: [],
      isAdmin: payload.isAdmin,
      messageOrigin: "text",
      toolNames: ["system_config"]
    }
  };
}

function assertHeldMutation(outbox: OutboxRecord, mutationFingerprint: string) {
  if (outbox.mutationFingerprint !== mutationFingerprint) {
    throw new Error(`Held outbox ${outbox.id} mutation fingerprint changed.`);
  }
  if (!outbox.holdProvenance) {
    throw new Error(`Held outbox ${outbox.id} is missing trusted provenance.`);
  }
}

function assertSameReleaseProvenance(
  outbox: OutboxRecord,
  outcome: "released" | "fallback_released",
  replyGate: HeldOutboxReplyGateV1
) {
  if (outbox.releaseProvenance?.outcome !== outcome ||
    !sameReplyGate(outbox.releaseProvenance.replyGate, replyGate)) {
    throw new Error(`Held outbox ${outbox.id} release provenance changed.`);
  }
}

function assertReleaseGate(
  provenance: HeldOutboxProvenanceV1,
  current: HeldOutboxReplyGateV1,
  allowFallbackBeforeOrAfterCommit: boolean
) {
  const original = provenance.originalReplyGate;
  if (original.scope !== current.scope || original.conversationId !== current.conversationId) {
    throw new Error("Held outbox release gate does not match its original conversation gate.");
  }
  if (original.generation !== current.generation) {
    if (allowFallbackBeforeOrAfterCommit && current.scopeEpoch === 0 && current.conversationEpoch === 0) {
      return;
    }
    throw new Error("Held outbox release gate generation changed unexpectedly.");
  }
  if (original.conversationEpoch !== current.conversationEpoch) {
    throw new Error("Held outbox release gate conversation epoch changed unexpectedly.");
  }
  const unchanged = original.scopeEpoch === current.scopeEpoch;
  const expectedIncrement = provenance.releasePolicy === "private_scope_plus_one" &&
    original.scope === "private" && current.scopeEpoch === original.scopeEpoch + 1;
  if (provenance.releasePolicy === "unchanged") {
    if (!unchanged) throw new Error("Held outbox release gate changed unexpectedly.");
    return;
  }
  if (!expectedIncrement && !(allowFallbackBeforeOrAfterCommit && unchanged)) {
    throw new Error("Held outbox release gate does not contain the expected private scope increment.");
  }
}

function requireHoldProvenance(outbox: OutboxRecord) {
  if (!outbox.holdProvenance) throw new Error(`Held outbox ${outbox.id} is missing provenance.`);
  return outbox.holdProvenance;
}

function decodeHoldProvenance(value: unknown): HeldOutboxProvenanceV1 {
  const input = parseJsonRecord(value, "hold provenance");
  exactKeys(input, [
    "schemaVersion",
    "semantics",
    "originalReplyGate",
    "releasePolicy",
    "lineage"
  ], "hold provenance");
  if (input.schemaVersion !== 1 || input.semantics !== "system_config_confirmation" ||
    (input.releasePolicy !== "unchanged" && input.releasePolicy !== "private_scope_plus_one") ||
    !Array.isArray(input.lineage) || input.lineage.length > MAX_HELD_LINEAGE) {
    throw new Error("Held outbox provenance is invalid.");
  }
  return {
    schemaVersion: 1,
    semantics: "system_config_confirmation",
    originalReplyGate: readReplyGate(input.originalReplyGate, "hold provenance originalReplyGate"),
    releasePolicy: input.releasePolicy,
    lineage: input.lineage.map((entry, index) => decodeLineageEntry(entry, index))
  };
}

function decodeReleaseProvenance(value: unknown): HeldOutboxReleaseProvenanceV1 {
  const input = parseJsonRecord(value, "release provenance");
  exactKeys(input, ["schemaVersion", "outcome", "replyGate", "releasedAt"], "release provenance");
  if (input.schemaVersion !== 1 ||
    (input.outcome !== "released" && input.outcome !== "fallback_released") ||
    !nonNegativeSafeInteger(input.releasedAt)) {
    throw new Error("Held outbox release provenance is invalid.");
  }
  return {
    schemaVersion: 1,
    outcome: input.outcome,
    replyGate: readReplyGate(input.replyGate, "release provenance replyGate"),
    releasedAt: Number(input.releasedAt)
  };
}

function decodeLineageEntry(value: unknown, index: number): HeldOutboxLineageEntryV1 {
  const input = record(value);
  exactKeys(input, ["outboxId", "mutationFingerprint", "holdState"], `lineage[${index}]`);
  if (input.holdState !== "released" && input.holdState !== "fallback_released") {
    throw new Error(`Held outbox lineage[${index}] state is invalid.`);
  }
  return {
    outboxId: requiredBoundedString(input.outboxId, `lineage[${index}].outboxId`, 128),
    mutationFingerprint: requiredMutationFingerprint(input.mutationFingerprint),
    holdState: input.holdState
  };
}

function readReplyGate(value: unknown, label: string): HeldOutboxReplyGateV1 {
  const input = record(value);
  exactKeys(input, [
    "generation",
    "scope",
    "conversationId",
    "scopeEpoch",
    "conversationEpoch"
  ], label);
  if ((input.scope !== "private" && input.scope !== "user_group" && input.scope !== "bot_group") ||
    !nonNegativeSafeInteger(input.scopeEpoch) || !nonNegativeSafeInteger(input.conversationEpoch)) {
    throw new Error(`${label} is invalid.`);
  }
  return {
    generation: requiredBoundedString(input.generation, `${label}.generation`, 128),
    scope: input.scope,
    conversationId: requiredBoundedString(input.conversationId, `${label}.conversationId`, 256),
    scopeEpoch: Number(input.scopeEpoch),
    conversationEpoch: Number(input.conversationEpoch)
  };
}

function readHoldState(value: unknown): OutboxHoldState {
  if (value !== "none" && value !== "held" && value !== "released" && value !== "fallback_released") {
    throw new Error("Outbox hold state is invalid.");
  }
  return value;
}

function requiredMutationFingerprint(value: unknown) {
  if (typeof value !== "string" || !MUTATION_FINGERPRINT_PATTERN.test(value)) {
    throw new Error("Held outbox mutation fingerprint is invalid.");
  }
  return value;
}

function parseJsonRecord(value: unknown, label: string) {
  if (typeof value !== "string" || value.length > MAX_PROVENANCE_JSON_LENGTH) {
    throw new Error(`Held outbox ${label} is invalid.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`Held outbox ${label} is invalid.`);
  }
  return record(parsed);
}

function encodeProvenance(value: unknown) {
  const encoded = JSON.stringify(value);
  if (encoded.length > MAX_PROVENANCE_JSON_LENGTH) {
    throw new Error("Held outbox provenance exceeds its size limit.");
  }
  return encoded;
}

function exactKeys(value: Record<string, unknown>, expected: string[], label: string) {
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  if (actual.length !== canonical.length || actual.some((key, index) => key !== canonical[index])) {
    throw new Error(`Held outbox ${label} fields are invalid.`);
  }
}

function sameReplyGate(left: unknown, right: HeldOutboxReplyGateV1) {
  if (!left || typeof left !== "object" || Array.isArray(left)) return false;
  const gate = left as ReplyGateSnapshotV1;
  return gate.generation === right.generation && gate.scope === right.scope &&
    gate.conversationId === right.conversationId && gate.scopeEpoch === right.scopeEpoch &&
    gate.conversationEpoch === right.conversationEpoch;
}

function requiredBoundedString(value: unknown, label: string, maxLength: number) {
  if (typeof value !== "string" || !value.trim() || value.length > maxLength ||
    /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function nonNegativeSafeInteger(value: unknown) {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
