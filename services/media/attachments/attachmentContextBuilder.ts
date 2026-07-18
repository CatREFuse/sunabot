import path from "node:path";
import { readChunksSqlite, type AttachmentTextChunk } from "./chunks.js";
import { selectAttachmentContext, type AttachmentContextInput } from "./context.js";
import { ParserPipeline } from "./parserPipeline.js";
import type { AttachmentModelContext, ParsedAttachment } from "./types.js";
import { cloneAttachment } from "./attachmentServiceSupport.js";

const MAX_CONTEXT_CANDIDATE_CHUNKS_PER_ATTACHMENT = 32;
const MAX_CHUNK_INDEX_LINE_CHARACTERS = 256 * 1024;

export class AttachmentContextBuilder {
  constructor(
    private readonly cacheRoot: string,
    private readonly parser: ParserPipeline
  ) {}

  async build(
    attachments: readonly ParsedAttachment[],
    query = ""
  ): Promise<AttachmentModelContext> {
    const contextAttachments = attachments.map(cloneAttachment);
    const inputs: AttachmentContextInput[] = [];
    for (const attachment of contextAttachments) {
      let chunks: AttachmentTextChunk[] = [];
      if (attachment.chunkIndexPath) {
        try {
          chunks = await readChunksFile(
            this.absoluteCachePath(attachment.chunkIndexPath),
            query
          );
        } catch {
          markAttachmentCacheUnavailable(attachment, false);
        }
      }
      inputs.push({
        attachmentId: attachment.id,
        name: attachment.name,
        chunks,
        pageCount: attachment.visualSourcePath || attachment.visualPagePaths?.length
          ? attachment.pageCount
          : undefined
      });
    }

    const selection = selectAttachmentContext(inputs, query);
    const resolvedVisualPages = new Map<string, string>();
    const visualGroups = new Map<string, number[]>();
    for (const page of selection.visualPages) {
      const pages = visualGroups.get(page.attachmentId) ?? [];
      pages.push(page.pageNumber);
      visualGroups.set(page.attachmentId, pages);
    }
    await Promise.all([...visualGroups].map(async ([attachmentId, pageNumbers]) => {
      const attachment = contextAttachments.find((value) => value.id === attachmentId);
      if (!attachment) return;
      try {
        const result = await this.parser.ensureVisualPages(attachment, pageNumbers);
        for (const page of result.pages) {
          resolvedVisualPages.set(visualPageKey(attachment.id, page.pageNumber), page.path);
        }
        if (result.failedPageNumbers.length) {
          const hasPartialContent = result.pages.length > 0 || selection.textChunks.some(
            (chunk) => chunk.attachmentId === attachment.id
          );
          markAttachmentVisualUnavailable(attachment, hasPartialContent);
        }
      } catch {
        markAttachmentVisualUnavailable(attachment, selection.textChunks.some(
          (chunk) => chunk.attachmentId === attachment.id
        ));
      }
    }));

    const localImagePaths = selection.visualPages.flatMap((page) => {
      const imagePath = resolvedVisualPages.get(visualPageKey(page.attachmentId, page.pageNumber));
      return imagePath ? [imagePath] : [];
    });
    const statusLines = contextAttachments.map(formatAttachmentStatus);
    const textLines = selection.textChunks.map((selected) => {
      const location = selected.chunk.pageNumber
        ? `第 ${selected.chunk.pageNumber} 页`
        : selected.chunk.slideNumber
          ? `幻灯片 ${selected.chunk.slideNumber}`
          : selected.chunk.sheetName
            ? `工作表 ${selected.chunk.sheetName}`
            : `片段 ${selected.chunk.index + 1}`;
      return `【${selected.attachmentName} · ${location}】\n${selected.text}`;
    });
    return {
      text: [...statusLines, ...textLines].filter(Boolean).join("\n\n"),
      localImagePaths: uniqueStrings(localImagePaths),
      attachments: contextAttachments
    };
  }

  private absoluteCachePath(relativePath: string) {
    const absolute = path.resolve(this.cacheRoot, relativePath);
    const relative = path.relative(this.cacheRoot, absolute);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error("Attachment cache path escapes its root.");
    }
    return absolute;
  }
}

async function readChunksFile(filePath: string, query: string) {
  const queryTerms = attachmentQueryTerms(query);
  const candidates: Array<{ chunk: AttachmentTextChunk; score: number }> = [];
  let firstChunk: AttachmentTextChunk | undefined;
  for (const stored of readChunksSqlite(filePath)) {
    const chunk = validateIndexedChunk(stored);
    firstChunk ??= chunk;
    if (!queryTerms.length) {
      candidates.push({ chunk, score: 0 });
      if (candidates.length >= MAX_CONTEXT_CANDIDATE_CHUNKS_PER_ATTACHMENT) break;
      continue;
    }
    candidates.push({ chunk, score: scoreIndexedChunk(chunk.text, query, queryTerms) });
    candidates.sort((left, right) => right.score - left.score || left.chunk.index - right.chunk.index);
    if (candidates.length > MAX_CONTEXT_CANDIDATE_CHUNKS_PER_ATTACHMENT - 1) candidates.pop();
  }
  const selected = firstChunk
    ? [firstChunk, ...candidates.map((candidate) => candidate.chunk)]
    : candidates.map((candidate) => candidate.chunk);
  return uniqueChunks(selected).slice(0, MAX_CONTEXT_CANDIDATE_CHUNKS_PER_ATTACHMENT);
}

function validateIndexedChunk(parsed: AttachmentTextChunk) {
  if (
    typeof parsed.text !== "string" ||
    !Number.isSafeInteger(parsed.index) ||
    parsed.index < 0 ||
    parsed.text.length > MAX_CHUNK_INDEX_LINE_CHARACTERS
  ) throw new Error("Attachment chunk index is invalid.");
  return parsed;
}

function attachmentQueryTerms(value: string) {
  return value
    .slice(0, 4_096)
    .normalize("NFKC")
    .toLocaleLowerCase()
    .match(/\p{Script=Han}|[\p{L}\p{N}_]+/gu) ?? [];
}

function scoreIndexedChunk(text: string, query: string, terms: readonly string[]) {
  const normalizedText = text.normalize("NFKC").toLocaleLowerCase();
  let score = normalizedText.includes(query.slice(0, 4_096).normalize("NFKC").toLocaleLowerCase())
    ? 100
    : 0;
  for (const term of new Set(terms)) {
    let offset = 0;
    while ((offset = normalizedText.indexOf(term, offset)) >= 0) {
      score += 1;
      offset += Math.max(1, term.length);
    }
  }
  return score;
}

function uniqueChunks(values: readonly AttachmentTextChunk[]) {
  const seen = new Set<number>();
  return values.filter((chunk) => {
    if (seen.has(chunk.index)) return false;
    seen.add(chunk.index);
    return true;
  });
}

function formatAttachmentStatus(attachment: ParsedAttachment) {
  const details = [
    attachment.format || attachment.mimeType,
    attachment.pageCount ? `${attachment.pageCount} 页` : undefined,
    attachment.status === "partial" ? "部分读取" : undefined,
    attachment.status === "failed" || attachment.status === "unsupported" ||
      attachment.status === "too_large" || attachment.status === "partial"
      ? attachment.errorMessage
      : undefined
  ].filter(Boolean).join("；");
  return `文件：${attachment.name}${details ? `（${details}）` : ""}`;
}

function markAttachmentCacheUnavailable(attachment: ParsedAttachment, hasPartialContent: boolean) {
  attachment.status = hasPartialContent ? "partial" : "failed";
  attachment.errorCode = "cache_unavailable";
  attachment.errorMessage = hasPartialContent
    ? "文件文字仍可用，但部分缓存已不可用。"
    : "文件缓存已不可用，请重新发送。";
}

function markAttachmentVisualUnavailable(attachment: ParsedAttachment, hasPartialContent: boolean) {
  attachment.status = hasPartialContent ? "partial" : "failed";
  attachment.errorCode = "visual_unavailable";
  attachment.errorMessage = hasPartialContent
    ? "文件文字仍可用，但部分视觉页面暂时无法读取。"
    : "文件视觉内容暂时无法读取。";
}

function visualPageKey(attachmentId: string, pageNumber: number) {
  return `${attachmentId}\u0000${pageNumber}`;
}

function uniqueStrings(values: readonly string[]) {
  return [...new Set(values.filter(Boolean))];
}
