import type {
  MemoryIdentityConfig,
  MemoryRecord,
  SourceDefinition,
  UserProfileAggregate
} from "../types.js";
import { readMemoryText } from "./memoryText.js";
import {
  configuredAddressNames,
  earliestIsoLike,
  latestIsoLike,
  normalizeText,
  normalizeUserId,
  normalizeUserIds,
  optionalString,
  readAddressNames,
  uniqueStrings
} from "./normalizers.js";

export function mergeUserProfileRecords(
  config: MemoryIdentityConfig,
  source: SourceDefinition,
  records: MemoryRecord[]
) {
  const profiles = new Map<string, UserProfileAggregate>();
  const looseRecords: MemoryRecord[] = [];

  for (const record of records) {
    const userIds = profileRecordUserIds(record.value);
    if (!userIds.length) {
      looseRecords.push(record);
      continue;
    }
    for (const userId of userIds) {
      const recordTime = optionalString(record.value.time) ?? optionalString(record.value.createdAt) ?? "";
      const text = stripUserProfileFactPrefix(readMemoryText(source, record.value), userId, optionalString(record.value.userName));
      const profile = ensureUserProfileAggregate(profiles, userId, {
        id: userIds.length === 1 ? normalizeText(record.value.id) || `${source.id}_${userId}` : `${source.id}_${userId}`,
        userName: optionalString(record.value.userName) ?? "",
        addressNames: configuredAddressNames(config, userId, readAddressNames(record.value)),
        createdAt: optionalString(record.value.createdAt) ?? recordTime,
        updatedAt: optionalString(record.value.updatedAt) ?? recordTime,
        time: recordTime,
        source: optionalString(record.value.source) ?? ""
      });
      addUserProfileFacts(profile, splitProfileFactText(text));
    }
  }

  const profileRecords = [...profiles.values()]
    .sort((left, right) => left.userId.localeCompare(right.userId))
    .map((profile) => ({
      index: 0,
      value: userProfileAggregateValue(config, source, profile)
    }));
  return [...looseRecords, ...profileRecords].map((record, index) => ({
    index,
    value: record.value
  }));
}

export function profileRecordUserIds(value: Record<string, unknown>) {
  return uniqueStrings([
    normalizeUserId(value.userId),
    ...normalizeUserIds(value.userIds)
  ].filter(Boolean));
}

export function ensureUserProfileAggregate(
  profiles: Map<string, UserProfileAggregate>,
  userId: string,
  seed: Omit<UserProfileAggregate, "userId" | "facts" | "factKeys">
) {
  const existing = profiles.get(userId);
  if (existing) {
    if (seed.userName) existing.userName = seed.userName;
    existing.addressNames = uniqueStrings([...existing.addressNames, ...seed.addressNames]);
    existing.createdAt = earliestIsoLike(existing.createdAt, seed.createdAt);
    existing.updatedAt = latestIsoLike(existing.updatedAt, seed.updatedAt);
    existing.time = latestIsoLike(existing.time, seed.time);
    if (seed.source) existing.source = seed.source;
    return existing;
  }

  const profile: UserProfileAggregate = {
    ...seed,
    id: seed.id || `user_profile_${userId}`,
    userId,
    facts: [],
    factKeys: new Set()
  };
  profiles.set(userId, profile);
  return profile;
}

export function addUserProfileFacts(profile: UserProfileAggregate, facts: string[]) {
  for (const fact of facts) {
    const text = normalizeText(fact);
    if (!text) continue;
    const key = normalizeProfileFactKey(text);
    if (profile.factKeys.has(key)) continue;
    profile.factKeys.add(key);
    profile.facts.push(text);
  }
}

export function splitProfileFactText(text: string) {
  const normalized = normalizeText(text);
  if (!normalized) return [];
  return normalized
    .split(/\r?\n/)
    .map((line) => line.replace(/^[-*]\s+/, "").trim())
    .filter(Boolean);
}

export function normalizeProfileFactKey(text: string) {
  return normalizeText(text).replace(/\s+/g, " ").toLowerCase();
}

export function stripUserProfileFactPrefix(text: string, userId?: string, userName?: string) {
  const normalized = normalizeText(text);
  if (!normalized) return "";
  const idPattern = userId ? escapeRegExp(userId) : "\\d{5,}";
  const namePattern = userName ? `(?:[（(]${escapeRegExp(userName)}[）)])?` : "(?:[（(][^）)]*[）)])?";
  const exactPrefix = new RegExp(`^\\s*(?:QQ\\s*)?${idPattern}\\s*${namePattern}\\s*[:：]\\s*`);
  const genericPrefix = /^\s*QQ\s*\d{5,}\s*(?:[（(][^）)]*[）)])?\s*[:：]\s*/;
  return normalized
    .split(/\r?\n/)
    .map((line) => line.replace(exactPrefix, "").replace(genericPrefix, "").trim())
    .filter(Boolean)
    .join("\n");
}

export function formatUserProfileKey(userId?: string, userName?: string, fallback = "") {
  if (!userId) return fallback || "用户画像";
  return userName ? `QQ ${userId}（${userName}）` : `QQ ${userId}`;
}

export function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function userProfileAggregateValue(config: MemoryIdentityConfig, source: SourceDefinition, profile: UserProfileAggregate) {
  const fact = profile.facts.join("\n");
  const key = formatUserProfileKey(profile.userId, profile.userName);
  const value: Record<string, unknown> = {
    id: profile.id,
    key,
    value: fact,
    [source.field]: fact,
    userId: profile.userId,
    userIds: [profile.userId],
    createdAt: profile.createdAt || profile.time || profile.updatedAt || new Date().toISOString(),
    source: profile.source || "sunabot.memory.user_profile"
  };
  if (profile.userName) value.userName = profile.userName;
  value.addressNames = configuredAddressNames(config, profile.userId, profile.addressNames);
  if (profile.time) value.time = profile.time;
  if (profile.updatedAt) value.updatedAt = profile.updatedAt;
  return value;
}
