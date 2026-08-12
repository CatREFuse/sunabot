import type { AppConfig } from "../../../packages/contracts/admin/public.js";
import { normalizeText } from "../domain/normalizers.js";
import {
  formatUserProfileKey,
  profileRecordUserIds
} from "../domain/profileMergePolicy.js";
import { toMemoryEntry } from "../domain/entryMapper.js";
import { memoryMutationMutex } from "./mutationMutex.js";
import { memorySourcePath, readMemoryRecords, writeMemoryRecords } from "./repositoryStorage.js";
import { sourceById } from "./sources.js";

export interface ReplaceUserProfileFromToolInput {
  userId: string;
  userName: string;
  profile: string;
  addressNames: string[];
  sourceDecisionKey?: string;
}

export async function replaceUserProfileFromTool(
  config: AppConfig,
  input: ReplaceUserProfileFromToolInput
) {
  const source = sourceById("user_profile");
  const filePath = memorySourcePath(config, source);
  return memoryMutationMutex.runExclusive(async () => {
    const records = await readMemoryRecords(filePath);
    const existingIndex = records.findIndex((record) =>
      profileRecordUserIds(record.value).includes(input.userId)
    );
    const existing = existingIndex >= 0 ? records[existingIndex] : undefined;
    if (
      input.sourceDecisionKey
      && normalizeText(existing?.value.sourceDecisionKey) === input.sourceDecisionKey
    ) {
      return {
        entry: toMemoryEntry(source, existing!),
        beforeCount: records.length,
        afterCount: records.length,
        deduplicated: true
      };
    }

    const now = new Date().toISOString();
    const id = normalizeText(existing?.value.id) || `user_profile_${input.userId}`;
    const value: Record<string, unknown> = {
      id,
      key: formatUserProfileKey(input.userId, input.userName, id),
      value: input.profile,
      [source.field]: input.profile,
      userId: input.userId,
      userIds: [input.userId],
      userName: input.userName,
      addressNames: input.addressNames,
      createdAt: normalizeText(existing?.value.createdAt) || now,
      updatedAt: now,
      source: "sunabot.add_user_profile",
      ...(input.sourceDecisionKey ? { sourceDecisionKey: input.sourceDecisionKey } : {})
    };
    const nextRecords = existingIndex >= 0
      ? records.flatMap((record, index) => {
          if (!profileRecordUserIds(record.value).includes(input.userId)) return [record];
          return index === existingIndex ? [{ ...record, value }] : [];
        })
      : [...records, { index: records.length, value }];
    const normalized = nextRecords.map((record, index) => ({ index, value: record.value }));
    await writeMemoryRecords(filePath, normalized);
    const saved = normalized.find((record) => String(record.value.id) === id)!;
    return {
      entry: toMemoryEntry(source, saved),
      beforeCount: records.length,
      afterCount: normalized.length,
      deduplicated: false
    };
  });
}
