import type { AppConfig } from "../../../src/types.js";
import type { MemoryEntry, MemoryRecallInput } from "../types.js";
import { compareMemoryEntries } from "../domain/entryMapper.js";
import { normalizeLimit, normalizeText } from "../domain/normalizers.js";
import { readSourceEntries } from "../application/queries.js";
import { selectSources } from "../application/sources.js";

export async function recallMemory(config: AppConfig, input: MemoryRecallInput = {}) {
  const query = normalizeText(input.query);
  const limit = normalizeLimit(input.limit, 8);
  if (!query) {
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
  return {
    ok: true,
    query,
    matches
  };
}

export function formatMemoryMatchesForPrompt(matches: MemoryEntry[]) {
  return matches
    .map((item) => {
      const date = item.occurredAt || item.updatedAt || item.createdAt || item.time || "";
      const suffix = date ? ` ${date}` : "";
      const userId = normalizeText(item.userId ?? item.userIds?.[0]);
      const userName = normalizeText(item.userName);
      const identity = userId && userName && userId !== userName
        ? ` ${userName}（QQ ${userId}）`
        : "";
      const address = item.source === "user_profile" && item.addressName ? ` 称呼：${item.addressName}` : "";
      return `${item.sourceTitle}${suffix}${identity}${address}：${item.text}`;
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
      entry.userName,
      entry.addressName,
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
