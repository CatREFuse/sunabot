import type { DatabaseSync } from "node:sqlite";
import {
  isGroupThreadStateV1,
  type GroupThreadStateV1
} from "../../services/conversations/groupThreadContext.js";

type SqlRow = Record<string, unknown>;

export interface GroupThreadStateRecord {
  conversationId: string;
  stateSchemaVersion: 1;
  revision: number;
  processedThroughSequence: number;
  lastRunKey: string;
  classifierModel: string;
  promptRevision: string;
  state: GroupThreadStateV1;
  createdAt: string;
  updatedAt: string;
}

export interface CommitGroupThreadStateInput {
  conversationId: string;
  baseRevision: number;
  lastRunKey: string;
  classifierModel: string;
  promptRevision: string;
  state: GroupThreadStateV1;
  now?: Date;
}

export type CommitGroupThreadStateResult =
  | { status: "committed" | "existing"; record: GroupThreadStateRecord }
  | { status: "snapshot_conflict" | "sequence_conflict"; current?: GroupThreadStateRecord };

export class GroupThreadStateStore {
  constructor(private readonly database: DatabaseSync) {}

  read(conversationId: string) {
    return this.readUnsafe(requiredText(conversationId, "conversationId"));
  }

  commit(input: CommitGroupThreadStateInput): CommitGroupThreadStateResult {
    const conversationId = requiredText(input.conversationId, "conversationId");
    const baseRevision = nonNegativeSafeInteger(input.baseRevision, "baseRevision");
    const lastRunKey = requiredText(input.lastRunKey, "lastRunKey");
    const classifierModel = requiredText(input.classifierModel, "classifierModel");
    const promptRevision = requiredText(input.promptRevision, "promptRevision");
    const state = validState(input.state);
    if (state.revision !== baseRevision + 1) {
      throw new Error("Group thread state revision must equal baseRevision + 1.");
    }
    const now = validDate(input.now ?? new Date()).toISOString();
    const stateJson = JSON.stringify(state);

    return this.transaction(() => {
      const current = this.readUnsafe(conversationId);
      if (current?.lastRunKey === lastRunKey) return { status: "existing", record: current };
      if ((current?.revision ?? 0) !== baseRevision) {
        return { status: "snapshot_conflict", ...(current ? { current } : {}) };
      }
      if (current && state.processedThroughSequence < current.processedThroughSequence) {
        return { status: "sequence_conflict", current };
      }

      const result = this.database.prepare(`
        INSERT INTO conversation_thread_states (
          conversation_id, state_schema_version, revision, processed_through_sequence,
          last_run_key, classifier_model, prompt_revision, state_json, created_at, updated_at
        ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(conversation_id) DO UPDATE SET
          state_schema_version = excluded.state_schema_version,
          revision = excluded.revision,
          processed_through_sequence = excluded.processed_through_sequence,
          last_run_key = excluded.last_run_key,
          classifier_model = excluded.classifier_model,
          prompt_revision = excluded.prompt_revision,
          state_json = excluded.state_json,
          updated_at = excluded.updated_at
        WHERE conversation_thread_states.revision = ?
          AND conversation_thread_states.processed_through_sequence <= excluded.processed_through_sequence
      `).run(
        conversationId,
        state.revision,
        state.processedThroughSequence,
        lastRunKey,
        classifierModel,
        promptRevision,
        stateJson,
        now,
        now,
        baseRevision
      );
      if (Number(result.changes) !== 1) {
        const latest = this.readUnsafe(conversationId);
        if ((latest?.processedThroughSequence ?? 0) > state.processedThroughSequence) {
          return { status: "sequence_conflict", ...(latest ? { current: latest } : {}) };
        }
        return { status: "snapshot_conflict", ...(latest ? { current: latest } : {}) };
      }
      const record = this.readUnsafe(conversationId);
      if (!record) throw new Error("Committed group thread state could not be read.");
      return { status: "committed", record };
    });
  }

  private readUnsafe(conversationId: string): GroupThreadStateRecord | undefined {
    const row = this.database.prepare(`
      SELECT conversation_id, state_schema_version, revision, processed_through_sequence,
        last_run_key, classifier_model, prompt_revision, state_json, created_at, updated_at
      FROM conversation_thread_states WHERE conversation_id = ?
    `).get(conversationId) as SqlRow | undefined;
    if (!row) return undefined;
    const stateSchemaVersion = Number(row.state_schema_version);
    if (stateSchemaVersion !== 1) throw new Error(`Unsupported group thread state schema version: ${stateSchemaVersion}.`);
    const state = validState(JSON.parse(String(row.state_json)));
    const revision = positiveSafeInteger(Number(row.revision), "stored revision");
    const processedThroughSequence = nonNegativeSafeInteger(
      Number(row.processed_through_sequence),
      "stored processedThroughSequence"
    );
    if (state.revision !== revision || state.processedThroughSequence !== processedThroughSequence) {
      throw new Error("Stored group thread state columns do not match state_json.");
    }
    return {
      conversationId: String(row.conversation_id),
      stateSchemaVersion: 1,
      revision,
      processedThroughSequence,
      lastRunKey: String(row.last_run_key),
      classifierModel: String(row.classifier_model),
      promptRevision: String(row.prompt_revision),
      state,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at)
    };
  }

  private transaction<T>(operation: () => T) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}

function validState(value: unknown) {
  if (!isGroupThreadStateV1(value)) throw new Error("Group thread state is invalid.");
  const state = value;
  positiveSafeInteger(state.revision, "state.revision");
  nonNegativeSafeInteger(state.processedThroughSequence, "state.processedThroughSequence");
  return state as GroupThreadStateV1;
}

function requiredText(value: unknown, field: string) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required.`);
  return value.trim();
}

function positiveSafeInteger(value: unknown, field: string) {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw new Error(`${field} must be a positive safe integer.`);
  return Number(value);
}

function nonNegativeSafeInteger(value: unknown, field: string) {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(`${field} must be a non-negative safe integer.`);
  }
  return Number(value);
}

function validDate(value: Date) {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new Error("now must be a valid Date.");
  return value;
}
