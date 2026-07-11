import type { AttachmentTextChunk } from "./chunks.js";

export const MAX_ATTACHMENT_CONTEXT_CHARACTERS = 120_000;
export const MAX_ATTACHMENT_VISUAL_PAGES = 12;

export interface AttachmentContextInput {
  attachmentId: string;
  name: string;
  chunks: readonly AttachmentTextChunk[];
  pageCount?: number;
  visualPageNumbers?: readonly number[];
}

export interface AttachmentContextOptions {
  maxCharacters?: number;
  maxVisualPages?: number;
}

export interface RankedAttachmentChunk {
  attachmentId: string;
  attachmentName: string;
  chunk: AttachmentTextChunk;
  score: number;
}

export interface SelectedAttachmentChunk extends RankedAttachmentChunk {
  text: string;
  truncated: boolean;
}

export interface SelectedVisualPage {
  attachmentId: string;
  attachmentName: string;
  pageNumber: number;
  score: number;
}

export interface AttachmentContextSelection {
  textChunks: SelectedAttachmentChunk[];
  characterCount: number;
  textTruncated: boolean;
  visualPages: SelectedVisualPage[];
  visualTruncated: boolean;
}

export function selectAttachmentContext(
  attachments: readonly AttachmentContextInput[],
  query = "",
  options: AttachmentContextOptions = {}
): AttachmentContextSelection {
  const maxCharacters = cappedNonNegativeInteger(
    options.maxCharacters,
    MAX_ATTACHMENT_CONTEXT_CHARACTERS,
    MAX_ATTACHMENT_CONTEXT_CHARACTERS,
    "maxCharacters"
  );
  const maxVisualPages = cappedNonNegativeInteger(
    options.maxVisualPages,
    MAX_ATTACHMENT_VISUAL_PAGES,
    MAX_ATTACHMENT_VISUAL_PAGES,
    "maxVisualPages"
  );
  const ranked = rankAttachmentChunks(attachments, query);
  const text = selectTextChunks(attachments, ranked, maxCharacters);
  const visual = selectVisualPages(attachments, ranked, query, maxVisualPages);
  return {
    textChunks: text.chunks,
    characterCount: text.characterCount,
    textTruncated: text.truncated,
    visualPages: visual.pages,
    visualTruncated: visual.truncated
  };
}

export function rankAttachmentChunks(
  attachments: readonly AttachmentContextInput[],
  query = ""
): RankedAttachmentChunk[] {
  const candidates = attachments.flatMap((attachment) => attachment.chunks.map((chunk) => ({
    attachmentId: attachment.attachmentId,
    attachmentName: attachment.name,
    chunk,
    score: 0
  })));
  const queryTerms = tokenize(query);
  if (!queryTerms.length) return candidates;

  const documents = candidates.map((candidate) => tokenize(candidate.chunk.text));
  const averageLength = documents.reduce((sum, terms) => sum + terms.length, 0) / Math.max(1, documents.length);
  const documentFrequency = new Map<string, number>();
  for (const terms of documents) {
    for (const term of new Set(terms)) documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
  }
  const normalizedQuery = normalizeForPhraseMatch(query);

  return candidates
    .map((candidate, index) => ({
      ...candidate,
      score: bm25Score(
        documents[index] ?? [],
        queryTerms,
        documentFrequency,
        documents.length,
        averageLength
      ) + phraseBoost(candidate.chunk.text, normalizedQuery)
    }))
    .sort((left, right) =>
      right.score - left.score ||
      attachmentOrder(attachments, left.attachmentId) - attachmentOrder(attachments, right.attachmentId) ||
      left.chunk.index - right.chunk.index
    );
}

function selectTextChunks(
  attachments: readonly AttachmentContextInput[],
  ranked: readonly RankedAttachmentChunk[],
  maxCharacters: number
) {
  const ordered: RankedAttachmentChunk[] = [];
  const selectedKeys = new Set<string>();
  for (const attachment of attachments) {
    const first = ranked.find((candidate) => candidate.attachmentId === attachment.attachmentId);
    if (!first) continue;
    ordered.push(first);
    selectedKeys.add(chunkKey(first));
  }
  for (const candidate of ranked) {
    if (selectedKeys.has(chunkKey(candidate))) continue;
    ordered.push(candidate);
  }

  const chunks: SelectedAttachmentChunk[] = [];
  let characterCount = 0;
  let sliced = false;
  for (const candidate of ordered) {
    const remaining = maxCharacters - characterCount;
    if (remaining <= 0) break;
    const text = candidate.chunk.text.slice(0, remaining);
    if (!text) continue;
    const truncated = text.length < candidate.chunk.text.length;
    chunks.push({ ...candidate, text, truncated });
    characterCount += text.length;
    if (truncated) {
      sliced = true;
      break;
    }
  }
  return {
    chunks,
    characterCount,
    truncated: sliced || chunks.length < ordered.filter((candidate) => candidate.chunk.text.length > 0).length
  };
}

export function selectVisualPages(
  attachments: readonly AttachmentContextInput[],
  rankedChunks: readonly RankedAttachmentChunk[],
  query = "",
  maxPages = MAX_ATTACHMENT_VISUAL_PAGES
) {
  const limit = cappedNonNegativeInteger(maxPages, MAX_ATTACHMENT_VISUAL_PAGES, MAX_ATTACHMENT_VISUAL_PAGES, "maxPages");
  const hasQuery = tokenize(query).length > 0;
  const available = attachments.map((attachment) => candidateVisualPages(
    attachment,
    rankedChunks,
    hasQuery,
    limit
  ));
  const totalAvailable = attachments.reduce(
    (sum, attachment) => Math.min(Number.MAX_SAFE_INTEGER, sum + availablePageCount(attachment)),
    0
  );
  if (limit === 0 || totalAvailable === 0) return { pages: [] as SelectedVisualPage[], truncated: totalAvailable > 0 };

  const scores = new Map<string, number>();
  for (const candidate of rankedChunks) {
    const pageNumber = candidate.chunk.pageNumber ?? candidate.chunk.slideNumber;
    if (!pageNumber) continue;
    const key = visualKey(candidate.attachmentId, pageNumber);
    scores.set(key, Math.max(scores.get(key) ?? 0, candidate.score));
  }

  const pages: SelectedVisualPage[] = [];
  const selected = new Set<string>();
  for (let index = 0; index < attachments.length && pages.length < limit; index += 1) {
    const pageNumber = available[index]?.[0];
    if (!pageNumber) continue;
    appendVisualPage(pages, selected, attachments[index]!, pageNumber, scores);
  }

  if (hasQuery) {
    const remaining = attachments.flatMap((attachment, attachmentIndex) =>
      (available[attachmentIndex] ?? []).map((pageNumber) => ({
        attachment,
        attachmentIndex,
        pageNumber,
        score: scores.get(visualKey(attachment.attachmentId, pageNumber)) ?? 0
      }))
    ).sort((left, right) =>
      right.score - left.score || left.attachmentIndex - right.attachmentIndex || left.pageNumber - right.pageNumber
    );
    for (const candidate of remaining) {
      if (pages.length >= limit) break;
      appendVisualPage(pages, selected, candidate.attachment, candidate.pageNumber, scores);
    }
  } else {
    let offset = 1;
    while (pages.length < limit) {
      let appended = false;
      for (let index = 0; index < attachments.length && pages.length < limit; index += 1) {
        const pageNumber = available[index]?.[offset];
        if (!pageNumber) continue;
        appended = appendVisualPage(pages, selected, attachments[index]!, pageNumber, scores) || appended;
      }
      if (!appended) break;
      offset += 1;
    }
  }

  return { pages, truncated: pages.length < totalAvailable };
}

function appendVisualPage(
  output: SelectedVisualPage[],
  selected: Set<string>,
  attachment: AttachmentContextInput,
  pageNumber: number,
  scores: ReadonlyMap<string, number>
) {
  const key = visualKey(attachment.attachmentId, pageNumber);
  if (selected.has(key)) return false;
  selected.add(key);
  output.push({
    attachmentId: attachment.attachmentId,
    attachmentName: attachment.name,
    pageNumber,
    score: scores.get(key) ?? 0
  });
  return true;
}

function availablePageCount(attachment: AttachmentContextInput) {
  if (attachment.visualPageNumbers) {
    return new Set(attachment.visualPageNumbers.filter(
      (value) => Number.isSafeInteger(value) && value > 0
    )).size;
  }
  return Number.isSafeInteger(attachment.pageCount) && (attachment.pageCount ?? 0) > 0
    ? attachment.pageCount!
    : 0;
}

function candidateVisualPages(
  attachment: AttachmentContextInput,
  rankedChunks: readonly RankedAttachmentChunk[],
  hasQuery: boolean,
  limit: number
) {
  const maximumCandidates = Math.max(1, limit * 2);
  const explicitPages = attachment.visualPageNumbers
    ? [...new Set(attachment.visualPageNumbers.filter(
      (value) => Number.isSafeInteger(value) && value > 0
    ))].sort((left, right) => left - right)
    : undefined;
  const pageCount = explicitPages ? 0 : availablePageCount(attachment);
  const isAvailable = (pageNumber: number) => explicitPages
    ? explicitPages.includes(pageNumber)
    : pageNumber <= pageCount;
  const candidates = new Set<number>();
  const firstPage = explicitPages?.[0] ?? (pageCount > 0 ? 1 : undefined);
  if (firstPage) candidates.add(firstPage);

  if (hasQuery) {
    for (const ranked of rankedChunks) {
      if (ranked.attachmentId !== attachment.attachmentId) continue;
      const pageNumber = ranked.chunk.pageNumber ?? ranked.chunk.slideNumber;
      if (!pageNumber || !isAvailable(pageNumber)) continue;
      candidates.add(pageNumber);
      if (candidates.size >= maximumCandidates) break;
    }
  }

  if (explicitPages) {
    for (const pageNumber of explicitPages) {
      candidates.add(pageNumber);
      if (candidates.size >= maximumCandidates) break;
    }
  } else {
    for (let pageNumber = 1; pageNumber <= pageCount && candidates.size < maximumCandidates; pageNumber += 1) {
      candidates.add(pageNumber);
    }
  }
  return [...candidates];
}

function bm25Score(
  documentTerms: readonly string[],
  queryTerms: readonly string[],
  documentFrequency: ReadonlyMap<string, number>,
  documentCount: number,
  averageLength: number
) {
  const frequencies = new Map<string, number>();
  for (const term of documentTerms) frequencies.set(term, (frequencies.get(term) ?? 0) + 1);
  let score = 0;
  const k1 = 1.2;
  const b = 0.75;
  for (const term of new Set(queryTerms)) {
    const frequency = frequencies.get(term) ?? 0;
    if (!frequency) continue;
    const frequencyInDocuments = documentFrequency.get(term) ?? 0;
    const inverseDocumentFrequency = Math.log(1 + (documentCount - frequencyInDocuments + 0.5) / (frequencyInDocuments + 0.5));
    const lengthFactor = 1 - b + b * documentTerms.length / Math.max(1, averageLength);
    score += inverseDocumentFrequency * frequency * (k1 + 1) / (frequency + k1 * lengthFactor);
  }
  return score;
}

function phraseBoost(text: string, normalizedQuery: string) {
  if (!normalizedQuery) return 0;
  return normalizeForPhraseMatch(text).includes(normalizedQuery) ? 2 : 0;
}

function tokenize(value: string) {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .match(/\p{Script=Han}|[\p{L}\p{N}_]+/gu) ?? [];
}

function normalizeForPhraseMatch(value: string) {
  return tokenize(value).join("");
}

function chunkKey(candidate: RankedAttachmentChunk) {
  return `${candidate.attachmentId}\u0000${candidate.chunk.index}`;
}

function visualKey(attachmentId: string, pageNumber: number) {
  return `${attachmentId}\u0000${pageNumber}`;
}

function attachmentOrder(attachments: readonly AttachmentContextInput[], attachmentId: string) {
  const index = attachments.findIndex((attachment) => attachment.attachmentId === attachmentId);
  return index < 0 ? Number.MAX_SAFE_INTEGER : index;
}

function cappedNonNegativeInteger(
  value: number | undefined,
  fallback: number,
  maximum: number,
  name: string
) {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 0) throw new RangeError(`${name} must be a non-negative integer`);
  return Math.min(result, maximum);
}
