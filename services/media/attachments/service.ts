import path from "node:path";
import { WORKSPACE_LAYOUT } from "../../../packages/platform/workspaceLayout.js";
import {
  AttachmentCacheError,
  AttachmentTooLargeError,
  CacheStore,
  type CacheStoreOptions
} from "./cache.js";
import { AttachmentContextBuilder } from "./attachmentContextBuilder.js";
import { FILE_SIZE_LIMIT_BYTES } from "./limits.js";
import {
  resolveAttachmentFallback,
  resolveAttachmentSource,
  type AttachmentSourcePort
} from "./resolver.js";
import type {
  AttachmentModelContext,
  IncomingAttachment,
  ParsedAttachment
} from "./types.js";
import { AttachmentWorkerSupervisor } from "./worker.js";
import { createParserWorkerSupervisor, ParserPipeline } from "./parserPipeline.js";
import {
  attachmentSourceKey,
  cacheResolvedAttachment,
  cloneAttachment,
  failAttachment,
  logAttachmentProcessing,
  parsedReuseKey,
  rebindParsedAttachment,
  shouldTryGetFileFallback,
  userFacingAttachmentError
} from "./attachmentServiceSupport.js";

const MAX_ATTACHMENTS_PER_MESSAGE = 4;
const MAX_PARSED_RESULT_CACHE_ENTRIES = 512;

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
  readonly parser: ParserPipeline;
  private readonly contextBuilder: AttachmentContextBuilder;
  private readonly parsedByReuseKey = new Map<string, ParsedAttachment>();
  private readonly parseQueuesByCacheKey = new Map<string, Promise<void>>();

  constructor(rootDir: string, options: AttachmentServiceOptions = {}) {
    this.cacheRoot = path.resolve(
      options.cacheRoot ?? path.join(rootDir, "workspace", WORKSPACE_LAYOUT.attachmentCache)
    );
    this.cache = options.cacheStore ?? new CacheStore(this.cacheRoot, options.cacheOptions);
    this.worker = options.workerSupervisor ?? createParserWorkerSupervisor();
    this.parser = new ParserPipeline({
      cacheRoot: this.cacheRoot,
      cache: this.cache,
      worker: this.worker
    });
    this.contextBuilder = new AttachmentContextBuilder(this.cacheRoot, this.parser);
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

  buildModelContext(
    attachments: readonly ParsedAttachment[],
    query = ""
  ): Promise<AttachmentModelContext> {
    return this.contextBuilder.build(attachments, query);
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
      const result = failAttachment(
        pending,
        "too_large",
        "too_large",
        "这个文件超过 256 MB，暂时无法读取。"
      );
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
        const result = await this.getOrParseCached(parsed, cached.filePath, query, cached.cacheHit);
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
        return failAttachment(
          pending,
          "too_large",
          "too_large",
          "这个文件超过 256 MB，暂时无法读取。"
        );
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
        ? await this.parser.loadParsedManifest(attachment)
        : undefined);
      if (queuedReusable) {
        if (!inMemory) this.rememberParsedResult(reuseKey, queuedReusable);
        return queuedReusable;
      }
      const parsed = await this.parser.parseCached(attachment, filePath, query);
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
}

export function pendingAttachments(values: readonly IncomingAttachment[]): ParsedAttachment[] {
  return values.map((value) => ({ ...value, status: "pending" }));
}
