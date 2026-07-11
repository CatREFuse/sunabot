import { randomUUID } from "node:crypto";
import {
  access,
  chmod,
  copyFile,
  link,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import path from "node:path";
import { WORKSPACE_LAYOUT } from "../../../packages/platform/workspaceLayout.js";
import { fileURLToPath } from "node:url";
import { CacheStore, AttachmentCacheError, AttachmentTooLargeError, type CacheStoreOptions } from "./cache.js";
import { readChunksSqlite, type AttachmentTextChunk } from "./chunks.js";
import { selectAttachmentContext, type AttachmentContextInput } from "./context.js";
import { detectAttachmentType, type DetectedAttachmentType } from "./detect.js";
import { normalizeAttachmentImage } from "./image.js";
import { FILE_SIZE_LIMIT_BYTES } from "./limits.js";
import type {
  BestEffortPdfRenderResult,
  IndexedDocumentResult
} from "./parser-worker-task.js";
import {
  resolveAttachmentFallback,
  resolveAttachmentSource,
  type AttachmentSourcePort,
  type ResolvedAttachmentSource
} from "./resolver.js";
import { extractTextFile } from "./text.js";
import type {
  AttachmentModelContext,
  IncomingAttachment,
  ParsedAttachment
} from "./types.js";
import {
  AttachmentWorkerSupervisor,
  type AttachmentWorkerSuccess
} from "./worker.js";

const MAX_ATTACHMENTS_PER_MESSAGE = 4;
const MAX_CONTEXT_CANDIDATE_CHUNKS_PER_ATTACHMENT = 32;
const MAX_CHUNK_INDEX_LINE_CHARACTERS = 256 * 1024;
const MAX_WORKER_RESULT_FILE_BYTES = 1024 * 1024;
const MAX_ATTACHMENT_PREVIEW_CHARACTERS = 2_000;
const MAX_PARSED_RESULT_CACHE_ENTRIES = 512;
const MAX_VISUAL_PAGE_WORK_BYTES = 24 * 1024 * 1024;

interface VisualPageBatchResult {
  pages: Array<{ pageNumber: number; path: string }>;
  failedPageNumbers: number[];
}

interface ParsedArtifactManifest {
  version: 1;
  status: ParsedAttachment["status"];
  mimeType?: string;
  format?: string;
  sizeBytes?: number;
  sha256: string;
  cacheKey: string;
  detectionHint: string;
  textPreview?: string;
  chunkIndexPath?: string;
  visualPagePaths?: string[];
  visualSourcePath?: string;
  pageCount?: number;
  textCharacterCount?: number;
  truncated?: boolean;
  errorCode?: string;
  errorMessage?: string;
}

export interface AttachmentServiceOptions {
  cacheRoot?: string;
  cacheStore?: CacheStore;
  workerSupervisor?: AttachmentWorkerSupervisor;
  cacheOptions?: CacheStoreOptions;
}

export class AttachmentService {
  readonly cacheRoot: string;
  readonly cache: CacheStore;
  readonly worker: AttachmentWorkerSupervisor;
  private readonly parsedByReuseKey = new Map<string, ParsedAttachment>();
  private readonly parseQueuesByCacheKey = new Map<string, Promise<void>>();
  private readonly visualBatchQueues = new Map<string, Promise<void>>();

  constructor(rootDir: string, options: AttachmentServiceOptions = {}) {
    this.cacheRoot = path.resolve(
      options.cacheRoot ?? path.join(rootDir, "workspace", WORKSPACE_LAYOUT.attachmentCache)
    );
    this.cache = options.cacheStore ?? new CacheStore(this.cacheRoot, options.cacheOptions);
    this.worker = options.workerSupervisor ?? createParserWorkerSupervisor();
  }

  async initialize() {
    await this.cache.initialize();
  }

  async processIncoming(
    incoming: readonly IncomingAttachment[],
    sourcePort: AttachmentSourcePort,
    query = "",
    referenceScope = ""
  ): Promise<ParsedAttachment[]> {
    await this.initialize();
    const results: ParsedAttachment[] = [];
    const processedSources = new Map<string, ParsedAttachment>();
    for (let index = 0; index < incoming.length; index += 1) {
      const attachment = incoming[index]!;
      if (index >= MAX_ATTACHMENTS_PER_MESSAGE) {
        const limited: ParsedAttachment = {
          ...attachment,
          status: "unsupported",
          errorCode: "attachment_count_limit",
          errorMessage: "一条消息最多读取 4 个文件。"
        };
        logAttachmentProcessing(limited, {
          referenceScope,
          durationMs: 0,
          declaredSizeBytes: attachment.sizeBytes,
          resolvedVia: "message_metadata"
        });
        results.push(limited);
        continue;
      }
      const sourceKey = attachmentSourceKey(attachment);
      const existing = sourceKey ? processedSources.get(sourceKey) : undefined;
      const parsed = existing
        ? rebindParsedAttachment(existing, attachment)
        : await this.processOne(
          attachment,
          sourcePort,
          query,
          referenceScope ? `${referenceScope}/${attachment.id}` : undefined
        );
      if (existing && parsed.cacheKey && referenceScope) {
        await this.cache.addReference(parsed.cacheKey, `${referenceScope}/${attachment.id}`);
      }
      if (sourceKey && !existing) processedSources.set(sourceKey, parsed);
      results.push(parsed);
    }
    return results;
  }

  async buildModelContext(
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
        pageCount: attachment.pageCount
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
        const result = await this.ensureVisualPages(attachment, pageNumbers);
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

  private async processOne(
    attachment: IncomingAttachment,
    sourcePort: AttachmentSourcePort,
    query: string,
    cacheReference?: string
  ): Promise<ParsedAttachment> {
    const startedAt = Date.now();
    let resolvedVia: string | undefined;
    let sourceKind: string | undefined;
    let cacheHit: boolean | undefined;
    const pending: ParsedAttachment = { ...attachment, status: "pending" };
    if ((attachment.sizeBytes ?? 0) > FILE_SIZE_LIMIT_BYTES) {
      const result = failAttachment(pending, "too_large", "too_large", "这个文件超过 256 MB，暂时无法读取。");
      logAttachmentProcessing(result, {
        referenceScope: cacheReference,
        durationMs: Date.now() - startedAt,
        declaredSizeBytes: attachment.sizeBytes,
        resolvedVia: "declared_size"
      });
      return result;
    }

    try {
      const source = await resolveAttachmentSource({
        fileId: attachment.fileId,
        file: attachment.name,
        url: attachment.url,
        busId: attachment.busId,
        groupId: attachment.groupId
      }, sourcePort);
      resolvedVia = source.via;
      sourceKind = source.kind;
      let cached;
      try {
        cached = await cacheResolvedAttachment(this.cache, source);
      } catch (error) {
        if (source.kind !== "url" || !shouldTryGetFileFallback(error)) throw error;
        const fallback = await resolveAttachmentFallback({
          fileId: attachment.fileId,
          file: attachment.name
        }, sourcePort);
        if (!fallback || (fallback.kind === "url" && fallback.url === source.url)) throw error;
        resolvedVia = `${source.via}->file_content`;
        sourceKind = fallback.kind;
        cached = await cacheResolvedAttachment(this.cache, fallback);
      }
      cacheHit = cached.cacheHit;
      let activeTaskHeld = cached.activeTaskRetained === true;
      if (!activeTaskHeld) {
        await this.cache.beginActiveTask(cached.cacheKey);
        activeTaskHeld = true;
      }
      try {
        const parsed: ParsedAttachment = {
          ...pending,
          sizeBytes: cached.sizeBytes,
          sha256: cached.sha256,
          cacheKey: cached.cacheKey
        };
        if (!cached.cacheHit) this.clearParsedResults(cached.cacheKey);
        const result = await this.getOrParseCached(
          parsed,
          cached.filePath,
          query,
          cached.cacheHit
        );
        if (cacheReference) await this.cache.addReference(cached.cacheKey, cacheReference);
        const rebound = rebindParsedAttachment(result, parsed);
        logAttachmentProcessing(rebound, {
          referenceScope: cacheReference,
          durationMs: Date.now() - startedAt,
          declaredSizeBytes: attachment.sizeBytes,
          resolvedVia,
          sourceKind,
          cacheHit
        });
        return rebound;
      } finally {
        if (activeTaskHeld) await this.cache.endActiveTask(cached.cacheKey);
      }
    } catch (error) {
      if (error instanceof AttachmentTooLargeError) {
        return failAttachment(pending, "too_large", "too_large", "这个文件超过 256 MB，暂时无法读取。");
      }
      const code = error instanceof AttachmentCacheError
        ? error.code
        : error instanceof Error && "code" in error
          ? String(error.code)
          : "attachment_failed";
      const result = failAttachment(pending, "failed", code, userFacingAttachmentError(code));
      logAttachmentProcessing(result, {
        referenceScope: cacheReference,
        durationMs: Date.now() - startedAt,
        declaredSizeBytes: attachment.sizeBytes,
        resolvedVia,
        sourceKind,
        cacheHit
      });
      return result;
    }
  }

  private async getOrParseCached(
    attachment: ParsedAttachment,
    filePath: string,
    query: string,
    cacheHit: boolean
  ) {
    const cacheKey = attachment.cacheKey!;
    const reuseKey = parsedReuseKey(cacheKey, attachment.name);
    const reusable = this.getParsedResult(reuseKey);
    if (reusable) return reusable;

    const previous = this.parseQueuesByCacheKey.get(cacheKey) ?? Promise.resolve();
    const task = previous.catch(() => undefined).then(async () => {
      const inMemory = this.getParsedResult(reuseKey);
      const queuedReusable = inMemory ?? (cacheHit
        ? await this.loadParsedManifest(attachment)
        : undefined);
      if (queuedReusable) {
        if (!inMemory) this.rememberParsedResult(reuseKey, queuedReusable);
        return queuedReusable;
      }
      const parsed = await this.parseCached(attachment, filePath, query);
      if (parsed.status === "ready" || parsed.status === "partial") {
        this.rememberParsedResult(reuseKey, parsed);
      }
      return parsed;
    });
    const queueTail = task.then(() => undefined, () => undefined);
    this.parseQueuesByCacheKey.set(cacheKey, queueTail);
    try {
      return await task;
    } finally {
      if (this.parseQueuesByCacheKey.get(cacheKey) === queueTail) {
        this.parseQueuesByCacheKey.delete(cacheKey);
      }
    }
  }

  private getParsedResult(reuseKey: string) {
    const cached = this.parsedByReuseKey.get(reuseKey);
    if (!cached) return undefined;
    this.parsedByReuseKey.delete(reuseKey);
    this.parsedByReuseKey.set(reuseKey, cached);
    return cloneAttachment(cached);
  }

  private rememberParsedResult(reuseKey: string, attachment: ParsedAttachment) {
    this.parsedByReuseKey.delete(reuseKey);
    this.parsedByReuseKey.set(reuseKey, cloneAttachment(attachment));
    while (this.parsedByReuseKey.size > MAX_PARSED_RESULT_CACHE_ENTRIES) {
      const oldestKey = this.parsedByReuseKey.keys().next().value as string | undefined;
      if (!oldestKey) break;
      this.parsedByReuseKey.delete(oldestKey);
    }
  }

  private clearParsedResults(cacheKey: string) {
    const prefix = `${cacheKey}\u0000`;
    for (const key of this.parsedByReuseKey.keys()) {
      if (key.startsWith(prefix)) this.parsedByReuseKey.delete(key);
    }
  }

  private async parseCached(
    attachment: ParsedAttachment,
    filePath: string,
    query: string
  ): Promise<ParsedAttachment> {
    const detected = await detectAttachmentType(filePath, {
      fileName: attachment.name,
      maxBytes: FILE_SIZE_LIMIT_BYTES
    });
    attachment.mimeType = detected.mimeType;
    attachment.format = detected.format;
    if (detected.kind === "unsupported") {
      return this.finishParse(failAttachment(
        attachment,
        "unsupported",
        "unsupported_file_type",
        "暂时无法读取这种文件格式。"
      ));
    }

    const artifactsDir = path.join(this.cacheRoot, attachment.cacheKey!, "artifacts");
    await mkdir(artifactsDir, { recursive: true, mode: 0o700 });
    try {
      let parsed: ParsedAttachment;
      if (detected.kind === "text") {
        parsed = await this.parseText(attachment, filePath, artifactsDir, detected);
      } else if (detected.kind === "pdf") {
        parsed = await this.parsePdf(attachment, filePath, artifactsDir, query);
      } else if (detected.kind === "image") {
        parsed = await this.parseImage(attachment, filePath, artifactsDir);
      } else {
        parsed = await this.parseOffice(attachment, filePath, artifactsDir, detected, query);
      }
      return this.finishParse(applyDetectionWarnings(parsed, detected));
    } catch (error) {
      return this.finishParse(failAttachment(
        attachment,
        "failed",
        "parse_failed",
        error instanceof Error && /password|encrypted/i.test(error.message)
          ? "文件无法解析，可能已加密或损坏。"
          : "文件无法解析，可能已损坏。"
      ));
    }
  }

  private async parseText(
    attachment: ParsedAttachment,
    filePath: string,
    artifactsDir: string,
    detected: DetectedAttachmentType
  ) {
    const chunksPath = path.join(artifactsDir, "chunks.sqlite");
    const result = await extractTextFile(filePath, {
      encodingDetection: detected.textEncoding,
      outputPath: chunksPath
    });
    return {
      ...attachment,
      status: result.truncated ? "partial" : "ready",
      textPreview: result.textPreview,
      textCharacterCount: result.characterCount,
      chunkIndexPath: this.relativeCachePath(chunksPath),
      truncated: result.truncated
    } satisfies ParsedAttachment;
  }

  private async parsePdf(
    attachment: ParsedAttachment,
    filePath: string,
    artifactsDir: string,
    query: string
  ) {
    const chunksPath = path.join(artifactsDir, "chunks.sqlite");
    const extraction = await this.runHeavy<IndexedDocumentResult>(
      artifactsDir,
      { kind: "pdf_extract", inputPath: filePath, outputPath: chunksPath }
    );
    const visualSourcePath = path.join(artifactsDir, "visual-source.pdf");
    await linkOrCopy(filePath, visualSourcePath);
    const result: ParsedAttachment = {
      ...attachment,
      status: extraction.truncated || extraction.textCharacterCount === 0 ? "partial" : "ready",
      textPreview: extraction.textPreview,
      textCharacterCount: extraction.indexedCharacterCount,
      chunkIndexPath: this.relativeCachePath(chunksPath),
      visualSourcePath: this.relativeCachePath(visualSourcePath),
      pageCount: extraction.pageCount,
      truncated: extraction.truncated
    };
    return result;
  }

  private async parseImage(
    attachment: ParsedAttachment,
    filePath: string,
    artifactsDir: string
  ) {
    const normalized = await normalizeAttachmentImage(filePath);
    const extension = normalized.format === "png" ? "png" : "jpg";
    const visualPath = path.join(artifactsDir, `image.${extension}`);
    await writeFileAtomically(visualPath, normalized.bytes);
    return {
      ...attachment,
      status: "ready",
      visualPagePaths: [this.relativeCachePath(visualPath)],
      pageCount: 1
    } satisfies ParsedAttachment;
  }

  private async parseOffice(
    attachment: ParsedAttachment,
    filePath: string,
    artifactsDir: string,
    detected: DetectedAttachmentType,
    query: string
  ) {
    const typedSource = await typedSourcePath(filePath, artifactsDir, detected.format ?? "bin");
    let parseSource = typedSource;
    if (detected.format === "ppt" || detected.format === "doc" || detected.format === "xls") {
      const outputFormat = detected.format === "ppt" ? "pptx" : detected.format === "doc" ? "docx" : "xlsx";
      parseSource = (await this.runHeavy<{ outputPath: string }>(
        artifactsDir,
        { kind: "libreoffice_convert", inputPath: typedSource, outputFormat }
      )).outputPath;
    }
    const chunksPath = path.join(artifactsDir, "chunks.sqlite");
    const extraction = await this.runHeavy<IndexedDocumentResult>(
      artifactsDir,
      { kind: "office_extract", inputPath: parseSource, outputPath: chunksPath }
    );
    const result: ParsedAttachment = {
      ...attachment,
      status: extraction.truncated || extraction.indexedCharacterCount === 0 ? "partial" : "ready",
      textPreview: extraction.textPreview,
      textCharacterCount: extraction.indexedCharacterCount,
      chunkIndexPath: this.relativeCachePath(chunksPath),
      pageCount: detected.kind === "presentation" ? extraction.sectionCount : undefined,
      truncated: extraction.truncated
    };

    if (detected.kind === "presentation") {
      try {
        const converted = await this.runHeavy<{ outputPath: string }>(
          artifactsDir,
          { kind: "libreoffice_convert", inputPath: typedSource, outputFormat: "pdf" }
        );
        const visualSourcePath = path.join(artifactsDir, "visual-source.pdf");
        if (path.resolve(converted.outputPath) !== path.resolve(visualSourcePath)) {
          await rm(visualSourcePath, { force: true });
          await rename(converted.outputPath, visualSourcePath);
        }
        result.visualSourcePath = this.relativeCachePath(visualSourcePath);
        const pdf = await this.runHeavy<{ pageCount: number }>(
          artifactsDir,
          { kind: "pdf_info", inputPath: visualSourcePath }
        );
        result.pageCount = pdf.pageCount;
      } catch {
        result.status = "partial";
        result.errorCode = "visual_conversion_failed";
        result.errorMessage = "演示文稿文字已读取，但视觉版式暂时无法读取。";
      }
    }
    return result;
  }

  private async ensureVisualPages(
    attachment: ParsedAttachment,
    pageNumbers: readonly number[]
  ): Promise<VisualPageBatchResult> {
    const requestedPages = uniquePositiveIntegers(pageNumbers);
    if (!requestedPages.length) return { pages: [], failedPageNumbers: [] };
    const taskKey = attachment.cacheKey ?? attachment.id;
    const previous = this.visualBatchQueues.get(taskKey) ?? Promise.resolve();
    const task = previous
      .catch(() => undefined)
      .then(() => this.ensureVisualPagesUnlocked(attachment, requestedPages));
    const queueTail = task.then(() => undefined, () => undefined);
    this.visualBatchQueues.set(taskKey, queueTail);
    try {
      return await task;
    } finally {
      if (this.visualBatchQueues.get(taskKey) === queueTail) {
        this.visualBatchQueues.delete(taskKey);
      }
    }
  }

  private async ensureVisualPagesUnlocked(
    attachment: ParsedAttachment,
    pageNumbers: readonly number[]
  ): Promise<VisualPageBatchResult> {
    if (!attachment.cacheKey) {
      return { pages: [], failedPageNumbers: pageNumbers.slice() };
    }
    if (!attachment.visualSourcePath) {
      const first = attachment.visualPagePaths?.[0];
      if (!first) return { pages: [], failedPageNumbers: pageNumbers.slice() };
      const firstPath = this.absoluteCachePath(first);
      await access(firstPath);
      return {
        pages: pageNumbers.includes(1) ? [{ pageNumber: 1, path: firstPath }] : [],
        failedPageNumbers: pageNumbers.filter((pageNumber) => pageNumber !== 1)
      };
    }
    const artifactsDir = path.join(this.cacheRoot, attachment.cacheKey, "artifacts", "visual");
    const outputByPage = new Map<number, string>();
    const missingPages: number[] = [];
    for (const pageNumber of pageNumbers) {
      const outputPath = await firstExistingPath([
        path.join(artifactsDir, `page-${pageNumber}.jpg`),
        path.join(artifactsDir, `page-${pageNumber}.png`)
      ]);
      if (outputPath) outputByPage.set(pageNumber, outputPath);
      else missingPages.push(pageNumber);
    }
    if (missingPages.length) {
      let releaseReservation: (() => Promise<void>) | undefined;
      await this.cache.beginActiveTask(attachment.cacheKey);
      try {
        releaseReservation = await this.cache.reserveArtifactBytes(Math.min(
          FILE_SIZE_LIMIT_BYTES,
          missingPages.length * MAX_VISUAL_PAGE_WORK_BYTES
        ));
        await mkdir(artifactsDir, { recursive: true, mode: 0o700 });
        const rendered = await this.runHeavy<BestEffortPdfRenderResult>(
          artifactsDir,
          {
            kind: "pdf_render_best_effort",
            inputPath: this.absoluteCachePath(attachment.visualSourcePath),
            pageNumbers: missingPages
          }
        );
        const failedPages = new Set(rendered.failures.map((failure) => failure.pageNumber));
        for (const renderedPage of rendered.pages) {
          try {
            const normalized = await normalizeAttachmentImage(renderedPage.outputPath);
            const outputPath = path.join(
              artifactsDir,
              `page-${renderedPage.pageNumber}.${normalized.format === "png" ? "png" : "jpg"}`
            );
            await writeFileAtomically(outputPath, normalized.bytes);
            outputByPage.set(renderedPage.pageNumber, outputPath);
            failedPages.delete(renderedPage.pageNumber);
          } catch {
            failedPages.add(renderedPage.pageNumber);
          } finally {
            await rm(renderedPage.outputPath, { force: true }).catch(() => undefined);
          }
        }
        for (const pageNumber of failedPages) outputByPage.delete(pageNumber);
      } finally {
        await releaseReservation?.();
        await this.cache.endActiveTask(attachment.cacheKey);
      }
    }
    await this.cache.updateParseState(attachment.cacheKey, {
      parseStatus: attachment.status === "ready" ? "ready" : "partial",
      artifactsSizeBytes: await directorySize(path.join(
        this.cacheRoot,
        attachment.cacheKey,
        "artifacts"
      ))
    });
    const pages = pageNumbers.flatMap((pageNumber) => {
      const outputPath = outputByPage.get(pageNumber);
      return outputPath ? [{ pageNumber, path: outputPath }] : [];
    });
    attachment.visualPagePaths = uniqueStrings([
      ...(attachment.visualPagePaths ?? []),
      ...pages.map((page) => this.relativeCachePath(page.path))
    ]);
    return {
      pages,
      failedPageNumbers: pageNumbers.filter((pageNumber) => !outputByPage.has(pageNumber))
    };
  }

  private async finishParse(attachment: ParsedAttachment) {
    if (attachment.cacheKey) {
      const artifactsDir = path.join(this.cacheRoot, attachment.cacheKey, "artifacts");
      await this.writeParsedManifest(attachment).catch(() => undefined);
      await this.cache.updateParseState(attachment.cacheKey, {
        parseStatus: attachment.status === "ready"
          ? "ready"
          : attachment.status === "partial"
            ? "partial"
            : "failed",
        artifactsSizeBytes: await directorySize(artifactsDir)
      });
    }
    return attachment;
  }

  private async loadParsedManifest(attachment: ParsedAttachment) {
    if (!attachment.cacheKey || !attachment.sha256) return undefined;
    try {
      const manifestPath = path.join(
        this.cacheRoot,
        attachment.cacheKey,
        "artifacts",
        "manifest.json"
      );
      const manifest = parseArtifactManifest(await readFile(manifestPath, "utf8"));
      if (
        manifest.cacheKey !== attachment.cacheKey ||
        manifest.sha256 !== attachment.sha256 ||
        manifest.sizeBytes !== attachment.sizeBytes ||
        manifest.detectionHint !== attachmentDetectionHint(attachment.name) ||
        !["ready", "partial"].includes(manifest.status)
      ) return undefined;
      await validateManifestArtifacts(this.cacheRoot, manifest);
      return {
        ...attachment,
        status: manifest.status,
        mimeType: manifest.mimeType,
        format: manifest.format,
        sizeBytes: manifest.sizeBytes,
        sha256: manifest.sha256,
        cacheKey: manifest.cacheKey,
        textPreview: manifest.textPreview,
        chunkIndexPath: manifest.chunkIndexPath,
        visualPagePaths: manifest.visualPagePaths?.slice(),
        visualSourcePath: manifest.visualSourcePath,
        pageCount: manifest.pageCount,
        textCharacterCount: manifest.textCharacterCount,
        truncated: manifest.truncated,
        errorCode: manifest.errorCode,
        errorMessage: manifest.errorMessage
      } satisfies ParsedAttachment;
    } catch {
      return undefined;
    }
  }

  private async writeParsedManifest(attachment: ParsedAttachment) {
    if (!attachment.cacheKey || !attachment.sha256) return;
    const manifest: ParsedArtifactManifest = {
      version: 1,
      status: attachment.status,
      mimeType: attachment.mimeType,
      format: attachment.format,
      sizeBytes: attachment.sizeBytes,
      sha256: attachment.sha256,
      cacheKey: attachment.cacheKey,
      detectionHint: attachmentDetectionHint(attachment.name),
      textPreview: attachment.textPreview?.slice(0, MAX_ATTACHMENT_PREVIEW_CHARACTERS),
      chunkIndexPath: attachment.chunkIndexPath,
      visualPagePaths: attachment.visualPagePaths?.slice(0, 12),
      visualSourcePath: attachment.visualSourcePath,
      pageCount: attachment.pageCount,
      textCharacterCount: attachment.textCharacterCount,
      truncated: attachment.truncated,
      errorCode: attachment.errorCode,
      errorMessage: attachment.errorMessage
    };
    const manifestPath = path.join(
      this.cacheRoot,
      attachment.cacheKey,
      "artifacts",
      "manifest.json"
    );
    await writeFileAtomically(manifestPath, Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`));
  }

  private async runHeavy<T>(workDir: string, payload: Record<string, unknown>): Promise<T> {
    const response = await this.worker.run<T>({
      taskId: randomUUID(),
      workDir,
      command: {
        kind: "module",
        modulePath: parserWorkerModulePath(),
        exportName: "default",
        payload
      }
    });
    return readWorkerResult<T>(response);
  }

  private absoluteCachePath(relativePath: string) {
    const absolute = path.resolve(this.cacheRoot, relativePath);
    const relative = path.relative(this.cacheRoot, absolute);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error("Attachment cache path escapes its root.");
    }
    return absolute;
  }

  private relativeCachePath(absolutePath: string) {
    return path.relative(this.cacheRoot, this.absoluteCachePath(path.relative(this.cacheRoot, absolutePath)));
  }
}

export function pendingAttachments(values: readonly IncomingAttachment[]): ParsedAttachment[] {
  return values.map((value) => ({ ...value, status: "pending" }));
}

function logAttachmentProcessing(
  attachment: ParsedAttachment,
  details: {
    referenceScope?: string;
    durationMs: number;
    declaredSizeBytes?: number;
    resolvedVia?: string;
    sourceKind?: string;
    cacheHit?: boolean;
  }
) {
  console.info("[attachment]", JSON.stringify({
    event: "attachment_processed",
    referenceScope: details.referenceScope,
    attachmentId: attachment.id,
    source: attachment.source,
    fileName: attachment.name,
    declaredSizeBytes: details.declaredSizeBytes,
    actualSizeBytes: attachment.sha256 ? attachment.sizeBytes : undefined,
    resolvedVia: details.resolvedVia,
    sourceKind: details.sourceKind,
    cacheHit: details.cacheHit,
    status: attachment.status,
    format: attachment.format,
    mimeType: attachment.mimeType,
    sha256Prefix: attachment.sha256?.slice(0, 12),
    pageCount: attachment.pageCount,
    textCharacterCount: attachment.textCharacterCount,
    visualPageCount: attachment.visualPagePaths?.length ?? 0,
    durationMs: Math.max(0, Math.trunc(details.durationMs)),
    errorCode: attachment.errorCode
  }));
}

function cacheResolvedAttachment(
  cache: CacheStore,
  source: ResolvedAttachmentSource
) {
  if (source.kind === "url") {
    return cache.downloadHttp(source.url, { retainActiveTask: true });
  }
  if (source.kind === "base64") {
    return cache.writeBase64(source.base64, { retainActiveTask: true });
  }
  return cache.importFile(source.filePath, { retainActiveTask: true });
}

function shouldTryGetFileFallback(error: unknown) {
  return error instanceof AttachmentCacheError && [
    "connect_timeout",
    "download_failed",
    "http_status",
    "idle_timeout",
    "invalid_url",
    "missing_response_body",
    "redirect_limit",
    "unsafe_url"
  ].includes(error.code);
}

function applyDetectionWarnings(
  attachment: ParsedAttachment,
  detected: DetectedAttachmentType
) {
  if (attachment.status !== "ready" && attachment.status !== "partial") return attachment;
  if (detected.extensionMismatch) {
    return {
      ...attachment,
      status: "partial",
      errorCode: attachment.errorCode ?? "extension_mismatch",
      errorMessage: attachment.errorMessage ?? "文件扩展名与实际格式不一致，已按检测到的格式读取。"
    } satisfies ParsedAttachment;
  }
  if (detected.kind === "text" && detected.textEncoding?.uncertain) {
    return {
      ...attachment,
      status: "partial",
      errorCode: attachment.errorCode ?? "encoding_uncertain",
      errorMessage: attachment.errorMessage ?? "文件编码识别不完全确定，读取结果可能含有少量乱码。"
    } satisfies ParsedAttachment;
  }
  return attachment;
}

function createParserWorkerSupervisor() {
  const sourceRuntime = fileURLToPath(import.meta.url).endsWith(".ts");
  return new AttachmentWorkerSupervisor({
    workerEntryPath: fileURLToPath(new URL(sourceRuntime ? "./worker-entry.ts" : "./worker-entry.js", import.meta.url)),
    workerExecArgv: sourceRuntime ? ["--import", "tsx"] : []
  });
}

function parserWorkerModulePath() {
  const sourceRuntime = fileURLToPath(import.meta.url).endsWith(".ts");
  return fileURLToPath(new URL(
    sourceRuntime ? "./parser-worker-task.ts" : "./parser-worker-task.js",
    import.meta.url
  ));
}

async function readWorkerResult<T>(response: AttachmentWorkerSuccess<T>): Promise<T> {
  if (response.resultFile) {
    try {
      const resultStat = await stat(response.resultFile);
      if (
        response.resultBytes > MAX_WORKER_RESULT_FILE_BYTES ||
        resultStat.size > MAX_WORKER_RESULT_FILE_BYTES
      ) {
        throw new Error("Attachment worker metadata result is too large.");
      }
      return JSON.parse(await readFile(response.resultFile, "utf8")) as T;
    } finally {
      await rm(response.resultFile, { force: true });
    }
  }
  return response.result as T;
}

async function typedSourcePath(filePath: string, artifactsDir: string, format: string) {
  const typedPath = path.join(artifactsDir, `source.${format.replace(/[^a-z0-9]/gi, "") || "bin"}`);
  await linkOrCopy(filePath, typedPath);
  return typedPath;
}

async function linkOrCopy(source: string, destination: string) {
  await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  await rm(destination, { force: true });
  try {
    await link(source, destination);
  } catch {
    await copyFile(source, destination);
  }
  await chmod(destination, 0o600);
  return destination;
}

async function firstExistingPath(candidates: readonly string[]) {
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Continue to the next controlled cache path.
    }
  }
  return undefined;
}

async function writeFileAtomically(filePath: string, bytes: Uint8Array) {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${filePath}.${randomUUID()}.part`;
  try {
    await writeFile(temporaryPath, bytes, { flag: "wx", mode: 0o600 });
    await rename(temporaryPath, filePath);
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
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
  ) {
    throw new Error("Attachment chunk index is invalid.");
  }
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
  let score = normalizedText.includes(query.slice(0, 4_096).normalize("NFKC").toLocaleLowerCase()) ? 100 : 0;
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

async function directorySize(directory: string): Promise<number> {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    let total = 0;
    for (const entry of entries) {
      const child = path.join(directory, entry.name);
      if (entry.isDirectory()) total += await directorySize(child);
      else if (entry.isFile()) total += (await stat(child)).size;
    }
    return total;
  } catch {
    return 0;
  }
}

function formatAttachmentStatus(attachment: ParsedAttachment) {
  const details = [
    attachment.format || attachment.mimeType,
    attachment.pageCount ? `${attachment.pageCount} 页` : undefined,
    attachment.status === "partial" ? "部分读取" : undefined,
    attachment.status === "failed" || attachment.status === "unsupported" || attachment.status === "too_large" || attachment.status === "partial"
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

function parseArtifactManifest(value: string): ParsedArtifactManifest {
  const parsed = JSON.parse(value) as Record<string, unknown>;
  const status = parsed.status;
  const sha256 = parsed.sha256;
  const cacheKey = parsed.cacheKey;
  const detectionHint = parsed.detectionHint;
  const sizeBytes = parsed.sizeBytes;
  if (
    parsed.version !== 1 ||
    !["ready", "partial", "unsupported", "failed"].includes(String(status)) ||
    typeof sha256 !== "string" || !/^[a-f0-9]{64}$/.test(sha256) ||
    typeof cacheKey !== "string" || cacheKey !== sha256 ||
    typeof detectionHint !== "string" || !detectionHint || detectionHint.length > 180 ||
    !Number.isSafeInteger(sizeBytes) || Number(sizeBytes) < 0
  ) {
    throw new Error("Attachment artifact manifest is invalid.");
  }
  return {
    version: 1,
    status: status as ParsedAttachment["status"],
    sha256,
    cacheKey,
    detectionHint,
    sizeBytes: Number(sizeBytes),
    mimeType: boundedManifestString(parsed.mimeType, 256),
    format: boundedManifestString(parsed.format, 64),
    textPreview: boundedManifestString(parsed.textPreview, MAX_ATTACHMENT_PREVIEW_CHARACTERS),
    chunkIndexPath: boundedManifestString(parsed.chunkIndexPath, 1_024),
    visualPagePaths: Array.isArray(parsed.visualPagePaths)
      ? parsed.visualPagePaths.slice(0, 12).map((item) => boundedManifestString(item, 1_024) ?? "").filter(Boolean)
      : undefined,
    visualSourcePath: boundedManifestString(parsed.visualSourcePath, 1_024),
    pageCount: optionalManifestInteger(parsed.pageCount),
    textCharacterCount: optionalManifestInteger(parsed.textCharacterCount),
    truncated: typeof parsed.truncated === "boolean" ? parsed.truncated : undefined,
    errorCode: boundedManifestString(parsed.errorCode, 128),
    errorMessage: boundedManifestString(parsed.errorMessage, 1_000)
  };
}

async function validateManifestArtifacts(
  cacheRoot: string,
  manifest: ParsedArtifactManifest
) {
  const requiredPaths = [
    manifest.chunkIndexPath,
    manifest.visualSourcePath,
    ...(manifest.visualPagePaths ?? [])
  ].filter((value): value is string => Boolean(value));
  if (
    (manifest.status === "ready" || manifest.status === "partial") &&
    !requiredPaths.length
  ) {
    throw new Error("Attachment manifest has no reusable artifacts.");
  }
  const entryRoot = path.resolve(cacheRoot, manifest.cacheKey);
  for (const relativePath of requiredPaths) {
    const absolutePath = path.resolve(cacheRoot, relativePath);
    const relativeToEntry = path.relative(entryRoot, absolutePath);
    if (
      relativeToEntry === "" ||
      relativeToEntry === ".." ||
      relativeToEntry.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relativeToEntry)
    ) {
      throw new Error("Attachment manifest path escapes its cache entry.");
    }
    const fileStat = await lstat(absolutePath);
    if (!fileStat.isFile() || fileStat.isSymbolicLink()) {
      throw new Error("Attachment manifest artifact is not a regular file.");
    }
  }
}

function boundedManifestString(value: unknown, maximumLength: number) {
  if (typeof value !== "string") return undefined;
  const result = value.trim();
  if (!result || result.length > maximumLength) return undefined;
  return result;
}

function optionalManifestInteger(value: unknown) {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : undefined;
}

function failAttachment(
  attachment: ParsedAttachment,
  status: ParsedAttachment["status"],
  errorCode: string,
  errorMessage: string
): ParsedAttachment {
  return { ...attachment, status, errorCode, errorMessage };
}

function userFacingAttachmentError(code: string) {
  if (code === "too_large") return "这个文件超过 256 MB，暂时无法读取。";
  if (code === "attachment_unavailable" || code === "http_status" || code.includes("timeout")) {
    return "文件下载失败，请重新发送或稍后再试。";
  }
  return "文件读取失败，请重新发送或稍后再试。";
}

function cloneAttachment(attachment: ParsedAttachment): ParsedAttachment {
  return {
    ...attachment,
    visualPagePaths: attachment.visualPagePaths?.slice()
  };
}

function attachmentSourceKey(attachment: IncomingAttachment) {
  const owner = attachment.groupId != null
    ? `group:${attachment.groupId}`
    : attachment.userId != null
      ? `user:${attachment.userId}`
      : "unknown";
  if (attachment.fileId) return `${owner}:file:${attachment.fileId}`;
  if (attachment.url) return `url:${attachment.url}`;
  return undefined;
}

function rebindParsedAttachment(
  parsed: ParsedAttachment,
  incoming: IncomingAttachment | ParsedAttachment
): ParsedAttachment {
  return {
    ...parsed,
    ...incoming,
    status: parsed.status,
    mimeType: parsed.mimeType,
    format: parsed.format,
    sizeBytes: parsed.sizeBytes,
    sha256: parsed.sha256,
    cacheKey: parsed.cacheKey,
    textPreview: parsed.textPreview,
    chunkIndexPath: parsed.chunkIndexPath,
    visualPagePaths: parsed.visualPagePaths?.slice(),
    visualSourcePath: parsed.visualSourcePath,
    pageCount: parsed.pageCount,
    textCharacterCount: parsed.textCharacterCount,
    truncated: parsed.truncated,
    errorCode: parsed.errorCode,
    errorMessage: parsed.errorMessage
  };
}

function uniqueStrings(values: readonly string[]) {
  return [...new Set(values.filter(Boolean))];
}

function uniquePositiveIntegers(values: readonly number[]) {
  return [...new Set(values.filter((value) => Number.isSafeInteger(value) && value > 0))];
}

function visualPageKey(attachmentId: string, pageNumber: number) {
  return `${attachmentId}\u0000${pageNumber}`;
}

function parsedReuseKey(cacheKey: string, fileName: string) {
  return `${cacheKey}\u0000${attachmentDetectionHint(fileName)}`;
}

function attachmentDetectionHint(fileName: string) {
  return path.basename(fileName).normalize("NFKC").toLocaleLowerCase().slice(0, 180);
}
