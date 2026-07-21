import {
  WEBFETCH_MATCH_TOKEN_BUDGET,
  type BudgetedContent,
  type WebContentBlock
} from "./contentBlocks.js";

interface RankedBlock {
  block: WebContentBlock;
  score: number;
}

export function selectRelevantWebContent(
  blocks: readonly WebContentBlock[],
  query: string,
  budget = WEBFETCH_MATCH_TOKEN_BUDGET
): BudgetedContent | undefined {
  if (!blocks.length) return undefined;
  const queryTokens = tokenize(query);
  if (!queryTokens.length) return undefined;
  const documents = blocks.map((block) => tokenize(block.markdown));
  const documentFrequency = new Map<string, number>();
  for (const terms of documents) {
    for (const term of new Set(terms)) documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
  }
  const averageLength = documents.reduce((sum, terms) => sum + terms.length, 0) / Math.max(documents.length, 1);
  const normalizedQuery = normalizeText(query);
  const ranked: RankedBlock[] = blocks.map((block, index) => {
    const terms = documents[index]!;
    const heading = normalizeText(block.headingPath.join(" "));
    const body = normalizeText(block.markdown);
    const bm25 = bm25Score(terms, queryTokens, documentFrequency, documents.length, averageLength);
    const headingHits = queryTokens.filter((term) => heading.includes(term)).length / queryTokens.length;
    const ngramHits = overlap(cjkBigrams(normalizedQuery), cjkBigrams(body));
    const phrase = body.includes(normalizedQuery) ? 1 : nearbyTermScore(body, queryTokens);
    return { block, score: bm25 * 0.55 + headingHits * 0.2 + ngramHits * 0.15 + phrase * 0.1 };
  }).filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || left.block.index - right.block.index);
  if (!ranked.length || ranked[0]!.score < 0.08) return undefined;

  const selected = new Set<number>();
  let used = 0;
  for (const item of ranked) {
    if (item.score < Math.max(0.08, ranked[0]!.score * 0.18)) break;
    const candidates = [item.block.index - 1, item.block.index, item.block.index + 1]
      .filter((index) => index >= 0 && index < blocks.length && !selected.has(index));
    const cost = candidates.reduce((sum, index) => sum + blocks[index]!.estimatedTokens, 0);
    if (used + cost > budget && selected.size > 0) continue;
    for (const index of candidates) {
      if (used + blocks[index]!.estimatedTokens > budget) continue;
      selected.add(index);
      used += blocks[index]!.estimatedTokens;
    }
  }
  const ordered = [...selected].sort((left, right) => left - right).map((index) => blocks[index]!);
  if (!ordered.length) return undefined;
  return {
    content: ordered.map((block) => block.markdown).join("\n\n").trim(),
    truncated: ordered.length < blocks.length,
    omittedBlockCount: Math.max(0, blocks.length - ordered.length)
  };
}

function bm25Score(
  terms: readonly string[],
  queryTerms: readonly string[],
  documentFrequency: ReadonlyMap<string, number>,
  documentCount: number,
  averageLength: number
) {
  const counts = new Map<string, number>();
  for (const term of terms) counts.set(term, (counts.get(term) ?? 0) + 1);
  const k1 = 1.2;
  const b = 0.75;
  let score = 0;
  for (const term of new Set(queryTerms)) {
    const frequency = counts.get(term) ?? 0;
    if (!frequency) continue;
    const df = documentFrequency.get(term) ?? 0;
    const idf = Math.log(1 + (documentCount - df + 0.5) / (df + 0.5));
    score += idf * (frequency * (k1 + 1)) /
      (frequency + k1 * (1 - b + b * terms.length / Math.max(averageLength, 1)));
  }
  return score;
}

function tokenize(value: string) {
  const normalized = normalizeText(value);
  const words = normalized.match(/[a-z0-9]+(?:[-_.][a-z0-9]+)*/g) ?? [];
  return [...words, ...cjkBigrams(normalized)];
}

function normalizeText(value: string) {
  return value.normalize("NFKC").toLocaleLowerCase().replace(/\s+/gu, " ").trim();
}

function cjkBigrams(value: string) {
  const characters = [...value].filter((character) => /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(character));
  if (characters.length === 1) return characters;
  return characters.slice(0, -1).map((character, index) => `${character}${characters[index + 1]}`);
}

function overlap(left: readonly string[], right: readonly string[]) {
  if (!left.length) return 0;
  const rightSet = new Set(right);
  return new Set(left.filter((item) => rightSet.has(item))).size / new Set(left).size;
}

function nearbyTermScore(body: string, terms: readonly string[]) {
  const positions = terms.flatMap((term) => {
    const index = body.indexOf(term);
    return index < 0 ? [] : [index];
  });
  if (positions.length < Math.min(2, terms.length)) return 0;
  return Math.max(0, 1 - (Math.max(...positions) - Math.min(...positions)) / 400);
}
