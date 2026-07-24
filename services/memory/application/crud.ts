import { nanoid } from "nanoid";
import type { AppConfig } from "../../../packages/contracts/admin/public.js";
import { ServiceError } from "../../../packages/contracts/errors/serviceError.js";
import type {
  MemoryEntry,
  MemoryFactInput,
  MemorySourceId,
  MemoryWriteInput,
  NormalizedMemoryFact,
  SourceDefinition
} from "../types.js";
import { buildEventMemoryValue } from "../domain/eventMergePolicy.js";
import { toMemoryEntry } from "../domain/entryMapper.js";
import {
  configuredAddressNames,
  memoryRecordsEqual,
  normalizeAddressNames,
  normalizeIsoTimestamp,
  normalizeMemoryFactInputs,
  normalizeText,
  normalizeUserId,
  optionalString,
  parseEventTime,
  readAddressNames
} from "../domain/normalizers.js";
import {
  formatUserProfileKey,
  mergeUserProfileRecords,
  profileRecordUserIds,
  stripUserProfileFactPrefix
} from "../domain/profileMergePolicy.js";
import { badRequest, editableSource, sourceById } from "./sources.js";
import { readMemorySourceEntries } from "./queries.js";
import { memoryMutationMutex } from "./mutationMutex.js";
import { memorySourcePath, readMemoryRecords, writeMemoryRecords } from "./repositoryStorage.js";
import {
  appendWorkingMemoryDocumentItem,
  readWorkingMemoryDocument,
  replaceWorkingMemoryDocument,
  workingMemoryItemToEntry,
  workingMemoryItemsFromFacts
} from "../workingMemoryDocument.js";
import { recordMemoryOperation, type MemoryOperationActor } from "../operationAudit.js";

export async function createMemoryEntry(config: AppConfig, input: MemoryWriteInput = {}) {
  const source = editableSource(input.source);
  const text = normalizeText(input.text);
  if (!text) badRequest("MEMORY_INVALID", "记忆内容为空。", "text");
  if (source.id === "working") {
    const result = await appendWorkingMemoryDocumentItem(config, text, {
      conversationId: "web:admin",
      scope: "admin",
      title: "记忆管理"
    }, "admin");
    return workingMemoryItemToEntry(result.item);
  }

  const filePath = memorySourcePath(config, source);
  return memoryMutationMutex.runExclusive(async () => {
    const records = await readMemoryRecords(filePath);
    const now = new Date().toISOString();
    const value: Record<string, unknown> = {
      id: `${source.id}_${nanoid()}`,
      [source.field]: text,
      createdAt: now,
      source: "sunabot.memory.ui"
    };
    if (source.id === "user_profile") {
      const userId = normalizeUserId(input.userId);
      const userName = normalizeText(input.userName);
      const addressNames = configuredAddressNames(
        config,
        userId,
        normalizeAddressNames(input.addressNames ?? input.addressName)
      );
      if (userId) {
        value.userId = userId;
        value.userIds = [userId];
        value.id = `user_profile_${userId}`;
      }
      if (userName) value.userName = userName;
      value.addressNames = addressNames;
      value.value = text;
    }

    const record = { index: records.length, value };
    records.push(record);
    if (source.id === "user_profile" && normalizeUserId(value.userId)) {
      const mergedRecords = mergeUserProfileRecords(config, source, records, []);
      await writeMemoryRecords(filePath, mergedRecords);
      const userId = normalizeUserId(value.userId);
      const merged = mergedRecords.find((item) => profileRecordUserIds(item.value).includes(userId));
      if (merged) {
        const entry = toMemoryEntry(source, merged);
        recordMemoryOperation(config, {
          source: source.id,
          operation: "create",
          actor: "admin",
          outcome: "applied",
          recordIds: [entry.id],
          beforeCount: records.length - 1,
          afterCount: mergedRecords.length,
          changedCount: 1
        });
        return entry;
      }
    }
    await writeMemoryRecords(filePath, records);
    const entry = toMemoryEntry(source, record);
    recordMemoryOperation(config, {
      source: source.id,
      operation: "create",
      actor: "admin",
      outcome: "applied",
      recordIds: [entry.id],
      beforeCount: records.length - 1,
      afterCount: records.length,
      changedCount: 1
    });
    return entry;
  });
}

export async function updateMemoryEntry(config: AppConfig, input: MemoryWriteInput = {}) {
  const source = editableSource(input.source);
  const id = normalizeText(input.id);
  const text = normalizeText(input.text);
  if (!id) badRequest("MEMORY_INVALID", "记忆 ID 为空。", "id");
  if (!text) badRequest("MEMORY_INVALID", "记忆内容为空。", "text");
  if (source.id === "working") {
    return memoryMutationMutex.runExclusive(async () => {
      const current = await readWorkingMemoryDocument(config);
      const item = current.items.find((candidate) => candidate.id === id);
      if (!item) throw new ServiceError(404, "MEMORY_NOT_FOUND", "记忆不存在。", "id");
      const result = await replaceWorkingMemoryDocument(
        config,
        current.revision,
        current.items.map((candidate) => candidate.id === id ? { ...candidate, content: text } : candidate)
      );
      if (result.status === "conflict") {
        recordMemoryOperation(config, {
          source: "working",
          operation: "update",
          actor: "admin",
          outcome: "conflict",
          recordIds: [id],
          beforeCount: current.items.length,
          afterCount: current.items.length,
          changedCount: 0,
          beforeRevision: current.revision,
          reasonCode: "revision_conflict"
        });
        throw new ServiceError(409, "MEMORY_REVISION_CONFLICT", "工作记忆已变化，请刷新后重试。");
      }
      const entry = workingMemoryItemToEntry(result.current.items.find((candidate) => candidate.id === id)!);
      recordMemoryOperation(config, {
        source: "working",
        operation: "update",
        actor: "admin",
        outcome: result.status === "unchanged" ? "unchanged" : "applied",
        recordIds: [id],
        beforeCount: current.items.length,
        afterCount: result.current.items.length,
        changedCount: result.status === "unchanged" ? 0 : 1,
        beforeRevision: current.revision,
        afterRevision: result.current.revision
      });
      return entry;
    });
  }

  const filePath = memorySourcePath(config, source);
  return memoryMutationMutex.runExclusive(async () => {
    const records = await readMemoryRecords(filePath);
    const record = records.find((item) => String(item.value.id ?? "") === id);
    if (!record) throw new ServiceError(404, "MEMORY_NOT_FOUND", "记忆不存在。", "id");

    const nextText = source.id === "user_profile"
      ? stripUserProfileFactPrefix(text, optionalString(record.value.userId), optionalString(record.value.userName))
      : text;
    record.value[source.field] = nextText;
    record.value.updatedAt = new Date().toISOString();
    if (source.id === "user_profile") {
      record.value.value = nextText;
      record.value.key = formatUserProfileKey(optionalString(record.value.userId), optionalString(record.value.userName), id);
      const userId = normalizeUserId(record.value.userId);
      if (Object.hasOwn(input, "addressNames") || Object.hasOwn(input, "addressName")) {
        const addressNames = configuredAddressNames(
          config,
          userId,
          normalizeAddressNames(input.addressNames ?? input.addressName)
        );
        record.value.addressNames = addressNames;
      } else {
        record.value.addressNames = configuredAddressNames(config, userId, readAddressNames(record.value));
      }
      delete record.value.addressName;
      delete record.value.address_name;
      delete record.value.salutation;
    }

    await writeMemoryRecords(filePath, records);
    const entry = toMemoryEntry(source, record);
    recordMemoryOperation(config, {
      source: source.id,
      operation: "update",
      actor: "admin",
      outcome: "applied",
      recordIds: [id],
      beforeCount: records.length,
      afterCount: records.length,
      changedCount: 1
    });
    return entry;
  });
}

export async function deleteMemoryEntry(config: AppConfig, input: MemoryWriteInput = {}) {
  const source = editableSource(input.source);
  const id = normalizeText(input.id);
  if (!id) badRequest("MEMORY_INVALID", "记忆 ID 为空。", "id");
  if (source.id === "working") {
    return memoryMutationMutex.runExclusive(async () => {
      const current = await readWorkingMemoryDocument(config);
      const next = current.items.filter((candidate) => candidate.id !== id);
      if (next.length === current.items.length) {
        throw new ServiceError(404, "MEMORY_NOT_FOUND", "记忆不存在。", "id");
      }
      const result = await replaceWorkingMemoryDocument(config, current.revision, next);
      if (result.status === "conflict") {
        recordMemoryOperation(config, {
          source: "working",
          operation: "delete",
          actor: "admin",
          outcome: "conflict",
          recordIds: [id],
          beforeCount: current.items.length,
          afterCount: current.items.length,
          changedCount: 0,
          beforeRevision: current.revision,
          reasonCode: "revision_conflict"
        });
        throw new ServiceError(409, "MEMORY_REVISION_CONFLICT", "工作记忆已变化，请刷新后重试。");
      }
      recordMemoryOperation(config, {
        source: "working",
        operation: "delete",
        actor: "admin",
        outcome: "applied",
        recordIds: [id],
        beforeCount: current.items.length,
        afterCount: result.current.items.length,
        changedCount: 1,
        beforeRevision: current.revision,
        afterRevision: result.current.revision
      });
      return { ok: true };
    });
  }

  const filePath = memorySourcePath(config, source);
  return memoryMutationMutex.runExclusive(async () => {
    const records = await readMemoryRecords(filePath);
    const nextRecords = records.filter((item) => String(item.value.id ?? "") !== id);
    if (nextRecords.length === records.length) throw new ServiceError(404, "MEMORY_NOT_FOUND", "记忆不存在。", "id");

    await writeMemoryRecords(filePath, nextRecords.map((record, index) => ({ ...record, index })));
    recordMemoryOperation(config, {
      source: source.id,
      operation: "delete",
      actor: "admin",
      outcome: "applied",
      recordIds: [id],
      beforeCount: records.length,
      afterCount: nextRecords.length,
      changedCount: 1
    });
    return { ok: true };
  });
}

export async function appendMemoryFacts(
  config: AppConfig,
  sourceInput: MemorySourceId,
  facts: MemoryFactInput[],
  metadata: Record<string, unknown> = {}
) {
  const source = sourceById(sourceInput);
  if (!source.editable) badRequest("MEMORY_SOURCE_READ_ONLY", "该记忆来源不可编辑。", "source");

  const normalizedFacts = normalizeMemoryFactInputs(facts);
  if (!normalizedFacts.length) return [];
  if (source.id === "working") {
    return memoryMutationMutex.runExclusive(async () => {
      const current = await readWorkingMemoryDocument(config);
      const items = workingMemoryItemsFromFacts(
        [
          ...current.items.map((item) => ({
            id: item.id,
            fact: item.content,
            userId: item.userId,
            userIds: item.userIds,
            userName: item.userName,
            addressNames: item.addressNames,
            occurredAt: item.occurredAt,
            occurredEndAt: item.occurredEndAt,
            eventType: item.eventType,
            subjectKey: item.subjectKey,
            eventKey: item.eventKey,
            causalChainKey: item.causalChainKey
          })),
          ...normalizedFacts
        ],
        current.items,
        {
          ...metadata,
          conversationId: metadata.conversationId ?? "system:memory",
          conversationScope: metadata.conversationScope ?? "system",
          conversationTitle: metadata.conversationTitle ?? "系统记忆"
        },
        (_fact, index) => `working_${nanoid()}_${index}`
      );
      const result = await replaceWorkingMemoryDocument(config, current.revision, items);
      if (result.status === "conflict") {
        recordMemoryOperation(config, {
          source: "working",
          operation: "append",
          actor: memoryActor(metadata),
          outcome: "conflict",
          beforeCount: current.items.length,
          afterCount: current.items.length,
          changedCount: 0,
          beforeRevision: current.revision,
          batchId: optionalString(metadata.batchId),
          conversationId: optionalString(metadata.conversationId),
          conversationScope: optionalString(metadata.conversationScope),
          reasonCode: "revision_conflict"
        });
        throw new ServiceError(409, "MEMORY_REVISION_CONFLICT", "工作记忆已变化，请重试。");
      }
      const entries = result.current.items.slice(current.items.length).map(workingMemoryItemToEntry);
      recordMemoryOperation(config, {
        source: "working",
        operation: "append",
        actor: memoryActor(metadata),
        outcome: result.status === "unchanged" ? "unchanged" : "applied",
        recordIds: entries.map((entry) => entry.id),
        batchId: optionalString(metadata.batchId),
        conversationId: optionalString(metadata.conversationId),
        conversationScope: optionalString(metadata.conversationScope),
        beforeCount: current.items.length,
        afterCount: result.current.items.length,
        changedCount: entries.length,
        beforeRevision: current.revision,
        afterRevision: result.current.revision
      });
      return entries;
    });
  }

  const filePath = memorySourcePath(config, source);
  return memoryMutationMutex.runExclusive(async () => {
    if (source.id === "user_profile") {
      const beforeCount = (await readMemoryRecords(filePath)).length;
      const entries = await appendUserProfileFacts(config, source, normalizedFacts, metadata);
      recordMemoryOperation(config, {
        source: source.id,
        operation: "append",
        actor: memoryActor(metadata),
        outcome: "applied",
        recordIds: entries.map((entry) => entry.id),
        batchId: optionalString(metadata.batchId),
        conversationId: optionalString(metadata.conversationId),
        conversationScope: optionalString(metadata.conversationScope),
        beforeCount,
        afterCount: entries.length,
        changedCount: normalizedFacts.length
      });
      return entries;
    }

    const records = await readMemoryRecords(filePath);
    const now = new Date().toISOString();
    const nextRecords = normalizedFacts.map((item, offset) => {
      const value = buildEventMemoryValue(source, item, metadata, now, `${source.id}_${nanoid()}`);
      return {
        index: records.length + offset,
        value
      };
    });

    records.push(...nextRecords);
    await writeMemoryRecords(filePath, records);
    const entries = nextRecords.map((record) => toMemoryEntry(source, record));
    recordMemoryOperation(config, {
      source: source.id,
      operation: "append",
      actor: memoryActor(metadata),
      outcome: "applied",
      recordIds: entries.map((entry) => entry.id),
      batchId: optionalString(metadata.batchId),
      conversationId: optionalString(metadata.conversationId),
      conversationScope: optionalString(metadata.conversationScope),
      beforeCount: records.length - nextRecords.length,
      afterCount: records.length,
      changedCount: nextRecords.length
    });
    return entries;
  });
}

export async function mergeUserProfileMemory(config: AppConfig) {
  const source = sourceById("user_profile");
  const filePath = memorySourcePath(config, source);
  return memoryMutationMutex.runExclusive(async () => {
    const records = await readMemoryRecords(filePath);
    const nextRecords = mergeUserProfileRecords(config, source, records, []);
    if (memoryRecordsEqual(records, nextRecords)) {
      recordMemoryOperation(config, {
        source: "user_profile",
        operation: "merge",
        actor: "system",
        outcome: "unchanged",
        beforeCount: records.length,
        afterCount: nextRecords.length,
        changedCount: 0
      });
      return nextRecords.map((record) => toMemoryEntry(source, record));
    }
    await writeMemoryRecords(filePath, nextRecords);
    recordMemoryOperation(config, {
      source: "user_profile",
      operation: "merge",
      actor: "system",
      outcome: "applied",
      recordIds: nextRecords.map((record) => optionalString(record.value.id)).filter(Boolean) as string[],
      beforeCount: records.length,
      afterCount: nextRecords.length,
      changedCount: nextRecords.length
    });
    return nextRecords.map((record) => toMemoryEntry(source, record));
  });
}

export async function normalizeEventMemorySchema(config: AppConfig) {
  return memoryMutationMutex.runExclusive(async () => {
    let updated = 0;
    for (const sourceId of ["long_term"] as const) {
      const source = sourceById(sourceId);
      const filePath = memorySourcePath(config, source);
      const records = await readMemoryRecords(filePath);
      const nextRecords = records.map((record) => {
        const previous = record.value;
        const value = { ...previous };
        const range = parseEventTime(previous.occurredAt ?? previous.time, previous.occurredEndAt);
        const legacyTime = normalizeText(previous.time);
        value.schemaVersion = 2;
        value.occurredAt = range.occurredAt || null;
        value.occurredEndAt = range.occurredEndAt || null;
        value.observedAt = normalizeIsoTimestamp(previous.observedAt) || null;
        if (legacyTime && !range.occurredAt) value.legacyTime = legacyTime;
        delete value.time;
        if (!memoryRecordsEqual([record], [{ ...record, value }])) updated += 1;
        return { ...record, value };
      });
      if (!memoryRecordsEqual(records, nextRecords)) {
        await writeMemoryRecords(filePath, nextRecords);
      }
      recordMemoryOperation(config, {
        source: source.id,
        operation: "normalize",
        actor: "system",
        outcome: updated ? "applied" : "unchanged",
        beforeCount: records.length,
        afterCount: nextRecords.length,
        changedCount: updated
      });
    }
    return { updated };
  });
}

export async function readUserProfileForUser(config: AppConfig, userIdInput: unknown) {
  const userId = normalizeUserId(userIdInput);
  if (!userId) return undefined;
  const entries = await readMemorySourceEntries(config, "user_profile");
  return entries.find((entry) => entry.userId === userId || entry.userIds?.includes(userId));
}

export function resolveUserAddressName(
  config: AppConfig,
  userIdInput: unknown,
  profile?: Pick<MemoryEntry, "addressNames" | "addressName" | "userName">,
  runtimeName?: unknown
) {
  const userId = normalizeUserId(userIdInput);
  return resolveUserAddressNames(config, userId, profile, runtimeName)[0] ?? userId;
}

export function resolveUserAddressNames(
  config: AppConfig,
  userIdInput: unknown,
  profile?: Pick<MemoryEntry, "addressNames" | "addressName" | "userName">,
  runtimeNames?: unknown
) {
  const userId = normalizeUserId(userIdInput);
  return configuredAddressNames(config, userId, [
    ...normalizeAddressNames(profile?.addressNames ?? profile?.addressName),
    ...normalizeAddressNames(runtimeNames)
  ]);
}

export async function clearMemorySource(config: AppConfig, sourceInput: MemorySourceId) {
  const source = sourceById(sourceInput);
  if (!source.editable) badRequest("MEMORY_SOURCE_READ_ONLY", "该记忆来源不可编辑。", "source");
  if (source.id === "working") {
    await memoryMutationMutex.runExclusive(async () => {
      const current = await readWorkingMemoryDocument(config);
      const result = await replaceWorkingMemoryDocument(config, current.revision, []);
      if (result.status === "conflict") {
        recordMemoryOperation(config, {
          source: "working",
          operation: "clear",
          actor: "admin",
          outcome: "conflict",
          beforeCount: current.items.length,
          afterCount: current.items.length,
          changedCount: 0,
          beforeRevision: current.revision,
          reasonCode: "revision_conflict"
        });
        throw new ServiceError(409, "MEMORY_REVISION_CONFLICT", "工作记忆已变化，请重试。");
      }
      recordMemoryOperation(config, {
        source: "working",
        operation: "clear",
        actor: "admin",
        outcome: result.status === "unchanged" ? "unchanged" : "applied",
        recordIds: current.items.map((item) => item.id),
        beforeCount: current.items.length,
        afterCount: 0,
        changedCount: current.items.length,
        beforeRevision: current.revision,
        afterRevision: result.current.revision
      });
    });
    return;
  }
  await memoryMutationMutex.runExclusive(async () => {
    const filePath = memorySourcePath(config, source);
    const records = await readMemoryRecords(filePath);
    await writeMemoryRecords(filePath, []);
    recordMemoryOperation(config, {
      source: source.id,
      operation: "clear",
      actor: "admin",
      outcome: records.length ? "applied" : "unchanged",
      recordIds: records.map((record) => optionalString(record.value.id)).filter(Boolean) as string[],
      beforeCount: records.length,
      afterCount: 0,
      changedCount: records.length
    });
  });
}

export async function appendUserProfileFacts(
  config: AppConfig,
  source: SourceDefinition,
  facts: NormalizedMemoryFact[],
  metadata: Record<string, unknown>
) {
  const filePath = memorySourcePath(config, source);
  const records = await readMemoryRecords(filePath);
  const nextRecords = mergeUserProfileRecords(config, source, records, facts, metadata);
  await writeMemoryRecords(filePath, nextRecords);
  return nextRecords.map((record) => toMemoryEntry(source, record));
}

function memoryActor(metadata: Record<string, unknown>): MemoryOperationActor {
  const source = optionalString(metadata.source) ?? "";
  if (source.includes("dream")) return "dream";
  if (source.includes("batch") || source.includes("compress")) return "memory_pipeline";
  if (source.includes("ui") || source.includes("admin")) return "admin";
  return "system";
}
