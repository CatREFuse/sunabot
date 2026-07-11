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
import { fileURLToPath } from "node:url";
import type { CacheStore } from "./cache.js";
import { detectAttachmentType, type DetectedAttachmentType } from "./detect.js";
import { normalizeAttachmentImage } from "./image.js";
import { FILE_SIZE_LIMIT_BYTES } from "./limits.js";
import type {
  BestEffortPdfRenderResult,
  IndexedDocumentResult
} from "./parser-worker-task.js";
import { extractTextFile } from "./text.js";
import type { ParsedAttachment } from "./types.js";
import {
  AttachmentWorkerSupervisor,
  type AttachmentWorkerSuccess
} from "./worker.js";
import {
  applyDetectionWarnings,
  attachmentDetectionHint,
  failAttachment
} from "./attachmentServiceSupport.js";

const MAX_WORKER_RESULT_FILE_BYTES = 1024 * 1024;
const MAX_ATTACHMENT_PREVIEW_CHARACTERS = 2_000;
const MAX_VISUAL_PAGE_WORK_BYTES = 24 * 1024 * 1024;

export interface VisualPageBatchResult {
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

export interface ParserPipelineOptions {
  cacheRoot: string;
  cache: CacheStore;
  worker: AttachmentWorkerSupervisor;
}

export class ParserPipeline {
  private readonly cacheRoot: string;
  private readonly cache: CacheStore;
  private readonly worker: AttachmentWorkerSupervisor;
  private readonly visualBatchQueues = new Map<string, Promise<void>>();

  constructor(options: ParserPipelineOptions) {
    this.cacheRoot = options.cacheRoot;
    this.cache = options.cache;
    this.worker = options.worker;
  }

  async parseCached(
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

  async ensureVisualPages(
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

  async loadParsedManifest(attachment: ParsedAttachment) {
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
    _query: string
  ) {
    const chunksPath = path.join(artifactsDir, "chunks.sqlite");
    const extraction = await this.runHeavy<IndexedDocumentResult>(
      artifactsDir,
      { kind: "pdf_extract", inputPath: filePath, outputPath: chunksPath }
    );
    const visualSourcePath = path.join(artifactsDir, "visual-source.pdf");
    await linkOrCopy(filePath, visualSourcePath);
    return {
      ...attachment,
      status: extraction.truncated || extraction.textCharacterCount === 0 ? "partial" : "ready",
      textPreview: extraction.textPreview,
      textCharacterCount: extraction.indexedCharacterCount,
      chunkIndexPath: this.relativeCachePath(chunksPath),
      visualSourcePath: this.relativeCachePath(visualSourcePath),
      pageCount: extraction.pageCount,
      truncated: extraction.truncated
    } satisfies ParsedAttachment;
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
    _query: string
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
    return path.relative(
      this.cacheRoot,
      this.absoluteCachePath(path.relative(this.cacheRoot, absolutePath))
    );
  }
}

export function createParserWorkerSupervisor() {
  const sourceRuntime = fileURLToPath(import.meta.url).endsWith(".ts");
  return new AttachmentWorkerSupervisor({
    workerEntryPath: fileURLToPath(new URL(
      sourceRuntime ? "./worker-entry.ts" : "./worker-entry.js",
      import.meta.url
    )),
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
      ) throw new Error("Attachment worker metadata result is too large.");
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
  ) throw new Error("Attachment artifact manifest is invalid.");
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
      ? parsed.visualPagePaths.slice(0, 12).map((item) =>
        boundedManifestString(item, 1_024) ?? "").filter(Boolean)
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
  ) throw new Error("Attachment manifest has no reusable artifacts.");
  const entryRoot = path.resolve(cacheRoot, manifest.cacheKey);
  for (const relativePath of requiredPaths) {
    const absolutePath = path.resolve(cacheRoot, relativePath);
    const relativeToEntry = path.relative(entryRoot, absolutePath);
    if (
      relativeToEntry === "" ||
      relativeToEntry === ".." ||
      relativeToEntry.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relativeToEntry)
    ) throw new Error("Attachment manifest path escapes its cache entry.");
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

function uniqueStrings(values: readonly string[]) {
  return [...new Set(values.filter(Boolean))];
}

function uniquePositiveIntegers(values: readonly number[]) {
  return [...new Set(values.filter((value) => Number.isSafeInteger(value) && value > 0))];
}
