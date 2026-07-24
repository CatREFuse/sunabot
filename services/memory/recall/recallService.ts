import type { AppConfig } from "../../../packages/contracts/admin/public.js";
import type { MemoryEntry, MemoryRecallInput, MemoryRecallUsage } from "../types.js";
import { compareMemoryEntries } from "../domain/entryMapper.js";
import { normalizeLimit, normalizeText } from "../domain/normalizers.js";
import { readSourceEntries } from "../application/queries.js";
import { selectSources } from "../application/sources.js";
import { memoryRepository } from "../persistence.js";
import { dreamLocalDate, dreamSystemTimeZone } from "../dream/schedule.js";
import { recordMemoryOperation } from "../operationAudit.js";

export async function recallMemory(
  config: AppConfig,
  input: MemoryRecallInput = {}
) {
  const query = normalizeText(input.query);
  const limit = normalizeLimit(input.limit, 8);
  if (!query) {
    for (const source of selectSources(input.source)) {
      recordMemoryOperation(config, {
        source: source.id,
        operation: "recall",
        actor: "memory_recall",
        outcome: "rejected",
        beforeCount: 0,
        afterCount: 0,
        changedCount: 0,
        reasonCode: "empty_query"
      });
    }
    return {
      ok: false,
      query,
      matches: [],
      error: "Memory query is empty."
    };
  }

  const sources = selectSources(input.source);
  const corpus = (await Promise.all(sources.map((source) => readSourceEntries(config, source)))).flat();
  const matches = bm25Search(query, corpus, limit);
  for (const source of sources) {
    const sourceMatches = matches.filter((entry) => entry.source === source.id);
    recordMemoryOperation(config, {
      source: source.id,
      operation: "recall",
      actor: "memory_recall",
      outcome: "recorded",
      recordIds: sourceMatches.map((entry) => entry.id),
      beforeCount: corpus.filter((entry) => entry.source === source.id).length,
      afterCount: sourceMatches.length,
      changedCount: 0
    });
  }
  return {
    ok: true,
    query,
    matches
  };
}

export function recordModelContextRecall(
  config: AppConfig,
  matches: readonly MemoryEntry[],
  usage: MemoryRecallUsage
) {
  if (usage.kind !== "model_context") return;
  const recallKey = normalizeText(usage.recallKey);
  if (!recallKey) throw new Error("Memory model-context recall requires recallKey.");
  const recalledAt = usage.recalledAt ?? new Date();
  const localDate = usage.localDate ?? dreamLocalDate(recalledAt, dreamSystemTimeZone());
  const repository = memoryRepository(config);
  if (!repository.recordActualRecall) return;
  const recordedIds: string[] = [];
  for (const match of matches) {
    if (match.source !== "long_term") continue;
    const result = repository.recordActualRecall({
      recordId: match.id,
      recallKey,
      localDate,
      at: recalledAt
    });
    if (result.recorded) recordedIds.push(match.id);
  }
  recordMemoryOperation(config, {
    source: "long_term",
    operation: "record_recall",
    actor: "memory_recall",
    outcome: "recorded",
    recordIds: recordedIds,
    changedCount: recordedIds.length
  });
}

export function reserveModelContextRecall(
  config: AppConfig,
  matches: readonly MemoryEntry[],
  recallKeyInput: string,
  at = new Date()
) {
  const recallKey = normalizeText(recallKeyInput);
  if (!recallKey) throw new Error("Memory model-context exposure requires recallKey.");
  const repository = memoryRepository(config);
  const accepted: MemoryEntry[] = [];
  const stale: MemoryEntry[] = [];
  const reservedIds: string[] = [];
  for (const match of matches) {
    if (match.source !== "long_term") {
      accepted.push(match);
      continue;
    }
    const result = repository.reserveActualRecall({
      recordId: match.id,
      recallKey,
      at
    });
    if (result.reserved) reservedIds.push(match.id);
    (result.recordPresent ? accepted : stale).push(match);
  }
  recordMemoryOperation(config, {
    source: "long_term",
    operation: "reserve_recall",
    actor: "memory_recall",
    outcome: "reserved",
    recordIds: reservedIds,
    beforeCount: matches.filter((match) => match.source === "long_term").length,
    afterCount: accepted.filter((match) => match.source === "long_term").length,
    changedCount: reservedIds.length,
    reasonCode: stale.length ? "stale_records_filtered" : undefined
  });
  return { accepted, stale };
}

export function formatMemoryMatchesForPrompt(matches: MemoryEntry[]) {
  return matches
    .map((item) => {
      const date = item.occurredAt || item.updatedAt || item.createdAt || item.time || "";
      const suffix = date ? ` ${date}` : "";
      const userId = normalizeText(item.userId ?? item.userIds?.[0]);
      const addressName = normalizeText(item.addressNames?.[0]);
      const identity = userId && addressName
        ? ` ${addressName}（QQ ${userId}）`
        : "";
      const reality = item.eventType === "dream" ? "（梦境，非现实经历）" : "";
      const provenance = item.source === "working" && item.conversationId
        ? ` [记录时间=${item.recordedAt ?? date}; 会话来源=${item.conversationId}（${item.conversationScope ?? "unknown"}）]`
        : "";
      return `${item.sourceTitle}${reality}${suffix}${identity}${provenance}：${item.text}`;
    })
    .join("\n");
}

export function bm25Search(query: string, entries: MemoryEntry[], limit: number) {
  const queryTokens = tokenize(query);
  if (!queryTokens.length || !entries.length) return [];

  const documents = entries.map((entry) => {
    const tokens = tokenize([
      entry.text,
      entry.userId,
      ...(entry.userIds ?? []),
      ...(entry.addressNames ?? []),
      entry.occurredAt,
      entry.occurredEndAt
    ].filter(Boolean).join(" "));
    const frequencies = new Map<string, number>();
    for (const token of tokens) {
      frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
    }
    return { entry, tokens, frequencies };
  });

  const averageLength = documents.reduce((sum, document) => sum + document.tokens.length, 0) / documents.length || 1;
  const documentFrequency = new Map<string, number>();
  for (const token of new Set(queryTokens)) {
    documentFrequency.set(token, documents.filter((document) => document.frequencies.has(token)).length);
  }

  const k1 = 1.5;
  const b = 0.75;
  const scored = documents.map((document) => {
    let score = 0;
    for (const token of queryTokens) {
      const frequency = document.frequencies.get(token) ?? 0;
      if (!frequency) continue;

      const df = documentFrequency.get(token) ?? 0;
      const idf = Math.log(1 + (documents.length - df + 0.5) / (df + 0.5));
      const lengthNorm = frequency + k1 * (1 - b + b * (document.tokens.length / averageLength));
      score += idf * ((frequency * (k1 + 1)) / lengthNorm);
    }
    return {
      ...document.entry,
      score: Number(score.toFixed(4))
    };
  });

  return scored
    .filter((entry) => (entry.score ?? 0) > 0)
    .sort((left, right) => (right.score ?? 0) - (left.score ?? 0) || compareMemoryEntries(left, right))
    .slice(0, limit);
}

export function tokenize(input: string) {
  const normalized = input.toLowerCase().normalize("NFKC");
  const tokens: string[] = [];
  for (const match of normalized.matchAll(/[a-z0-9_]+|[\u4e00-\u9fff]/g)) {
    tokens.push(match[0]);
  }

  const cjkChars = [...normalized].filter((char) => /[\u4e00-\u9fff]/.test(char));
  for (let index = 0; index < cjkChars.length - 1; index += 1) {
    tokens.push(`${cjkChars[index]}${cjkChars[index + 1]}`);
  }

  return tokens.filter((token) => token.length > 0);
}
