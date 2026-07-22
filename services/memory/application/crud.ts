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

export async function createMemoryEntry(config: AppConfig, input: MemoryWriteInput = {}) {
  const source = editableSource(input.source);
  const text = normalizeText(input.text);
  if (!text) badRequest("MEMORY_INVALID", "记忆内容为空。", "text");

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
      if (merged) return toMemoryEntry(source, merged);
    }
    await writeMemoryRecords(filePath, records);
    return toMemoryEntry(source, record);
  });
}

export async function updateMemoryEntry(config: AppConfig, input: MemoryWriteInput = {}) {
  const source = editableSource(input.source);
  const id = normalizeText(input.id);
  const text = normalizeText(input.text);
  if (!id) badRequest("MEMORY_INVALID", "记忆 ID 为空。", "id");
  if (!text) badRequest("MEMORY_INVALID", "记忆内容为空。", "text");

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
    return toMemoryEntry(source, record);
  });
}

export async function deleteMemoryEntry(config: AppConfig, input: MemoryWriteInput = {}) {
  const source = editableSource(input.source);
  const id = normalizeText(input.id);
  if (!id) badRequest("MEMORY_INVALID", "记忆 ID 为空。", "id");

  const filePath = memorySourcePath(config, source);
  return memoryMutationMutex.runExclusive(async () => {
    const records = await readMemoryRecords(filePath);
    const nextRecords = records.filter((item) => String(item.value.id ?? "") !== id);
    if (nextRecords.length === records.length) throw new ServiceError(404, "MEMORY_NOT_FOUND", "记忆不存在。", "id");

    await writeMemoryRecords(filePath, nextRecords.map((record, index) => ({ ...record, index })));
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

  const filePath = memorySourcePath(config, source);
  return memoryMutationMutex.runExclusive(async () => {
    if (source.id === "user_profile") {
      return appendUserProfileFacts(config, source, normalizedFacts, metadata);
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
    return nextRecords.map((record) => toMemoryEntry(source, record));
  });
}

export async function mergeUserProfileMemory(config: AppConfig) {
  const source = sourceById("user_profile");
  const filePath = memorySourcePath(config, source);
  return memoryMutationMutex.runExclusive(async () => {
    const records = await readMemoryRecords(filePath);
    const nextRecords = mergeUserProfileRecords(config, source, records, []);
    if (memoryRecordsEqual(records, nextRecords)) {
      return nextRecords.map((record) => toMemoryEntry(source, record));
    }
    await writeMemoryRecords(filePath, nextRecords);
    return nextRecords.map((record) => toMemoryEntry(source, record));
  });
}

export async function normalizeEventMemorySchema(config: AppConfig) {
  return memoryMutationMutex.runExclusive(async () => {
    let updated = 0;
    for (const sourceId of ["working", "long_term"] as const) {
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
      if (!memoryRecordsEqual(records, nextRecords)) await writeMemoryRecords(filePath, nextRecords);
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
  await memoryMutationMutex.runExclusive(() => writeMemoryRecords(memorySourcePath(config, source), []));
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
