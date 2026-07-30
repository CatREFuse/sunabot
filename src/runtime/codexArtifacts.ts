import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { chatMediaPublisher } from "../../adapters/filesystem/chatMediaPublisher.js";
import { parentBoundUnlink } from "../../adapters/filesystem/parentBoundFs.js";
import type { ParsedAttachment } from "../../packages/contracts/media/media.js";
import type {
  CodexResultArtifactV1,
  CodexToolResult
} from "../../packages/contracts/tools/codex.js";
import type { AgentWorkbenchBackend } from "../../packages/platform/agentResourceLayout.js";
import type {
  CodexResultFinalization,
  CodexResultFinalizationInput
} from "../../services/sessions/sessionCoordinatorTypes.js";
import {
  codexResultSensitivePaths,
  redactCodexSensitivePaths,
  sanitizeCodexArtifactError
} from "../../services/sessions/codexResultSanitizer.js";
import type { CacheStore, CachedAttachment } from "../../services/media/attachments/cache.js";
import {
  ChatMediaExportService,
  type ChatMediaBoundSource,
  type ChatMediaPublisher
} from "../../services/media/chatMediaExport.js";

const MAX_CODEX_ARTIFACT_BYTES = 64 * 1024 * 1024;
const MAX_CODEX_ARTIFACT_TOTAL_BYTES = 128 * 1024 * 1024;
const MAX_CODEX_ARTIFACTS = 8;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const JOB_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/u;

export interface FinalizeCodexArtifactsInput extends CodexResultFinalizationInput {
  cache: CacheStore;
  publisher?: ChatMediaPublisher;
}

interface ValidatedCodexArtifact {
  declaration: CodexResultArtifactV1;
  cached: CachedAttachment;
}

interface PublishedCodexArtifact {
  filePath: string;
  parentIdentity: Parameters<typeof parentBoundUnlink>[0]["parentIdentity"];
  expectedTarget: Parameters<typeof parentBoundUnlink>[0]["expectedTarget"];
}

export async function finalizeCodexResultArtifacts(
  input: FinalizeCodexArtifactsInput
): Promise<CodexToolResult> {
  const staged = await stageCodexResultArtifacts(input);
  staged.commit();
  return staged.result;
}

export async function stageCodexResultArtifacts(
  input: FinalizeCodexArtifactsInput
): Promise<CodexResultFinalization> {
  const sensitivePaths = await codexResultSensitivePaths({
    job: input.job,
    settings: input.settings,
    resultFile: input.result.resultFile
  });
  try {
    return await stageCodexResultArtifactsUnchecked(input, sensitivePaths);
  } catch (error) {
    throw sanitizeCodexArtifactError(error, sensitivePaths);
  }
}

async function stageCodexResultArtifactsUnchecked(
  input: FinalizeCodexArtifactsInput,
  sensitivePaths: readonly string[]
): Promise<CodexResultFinalization> {
  if (!input.result.ok || input.result.status !== "succeeded") {
    return completedFinalization(withoutWorkerArtifacts(input.result, sensitivePaths));
  }
  const declarations = input.result.artifacts ?? [];
  if (!declarations.length) {
    return completedFinalization(withoutWorkerArtifacts(input.result, sensitivePaths));
  }
  if (declarations.length > MAX_CODEX_ARTIFACTS) {
    throw codexArtifactError("codex_artifact_count_invalid");
  }
  if (!JOB_ID_PATTERN.test(input.job.id) || input.result.jobId !== input.job.id) {
    throw codexArtifactError("codex_artifact_job_invalid");
  }
  const backend = readFrozenBackend(input.job.arguments);
  if (!backend) {
    throw codexArtifactError("codex_artifact_backend_missing");
  }
  const jobDir = await resolveJobDirectory(input.settings.jobRoot, input.job.id);
  const validated: ValidatedCodexArtifact[] = [];
  const publishedTargets: PublishedCodexArtifact[] = [];
  let totalBytes = 0;
  try {
    for (const declaration of declarations) {
      assertNotAborted(input.signal);
      const normalized = validateDeclaration(declaration);
      totalBytes += normalized.sizeBytes;
      if (totalBytes > MAX_CODEX_ARTIFACT_TOTAL_BYTES) {
        throw codexArtifactError("codex_artifact_total_too_large");
      }
      const sourcePath = await resolveArtifactSource(
        jobDir,
        normalized.relativePath,
        input.job
      );
      await verifyArtifactSource(sourcePath, normalized, input.signal);
      const cached = await input.cache.importFile(sourcePath, {
        signal: input.signal,
        maxBytes: MAX_CODEX_ARTIFACT_BYTES,
        retainActiveTask: true
      });
      if (
        cached.sha256 !== normalized.sha256
        || cached.sizeBytes !== normalized.sizeBytes
        || cached.activeTaskRetained !== true
      ) {
        if (cached.activeTaskRetained) await input.cache.endActiveTask(cached.cacheKey);
        throw codexArtifactError("codex_artifact_source_changed");
      }
      validated.push({ declaration: normalized, cached });
    }

    const sources = new Map<string, ChatMediaBoundSource>();
    for (const [index, artifact] of validated.entries()) {
      sources.set(internalArtifactHandle(input.job.id, index), {
        kind: "file",
        attachment: cachedArtifactAttachment(input.job.id, index, artifact)
      });
    }
    const exporter = new ChatMediaExportService({
      agentWorkspace: input.settings.workspacePath,
      cache: input.cache,
      sources,
      publisher: trackedPublisher(
        input.publisher ?? chatMediaPublisher,
        publishedTargets
      ),
      backend,
      allowUnsupportedFiles: true,
      contentAddressedNamePrefix: artifactPublicationPrefix(input.job),
      isCurrent: () => !input.signal.aborted
    });
    const published: CodexResultArtifactV1[] = [];
    try {
      for (const [index, artifact] of validated.entries()) {
        assertNotAborted(input.signal);
        const exported = await exporter.export({
          handle: internalArtifactHandle(input.job.id, index)
        });
        assertNotAborted(input.signal);
        published.push({
          schemaVersion: 1,
          relativePath: exported.path,
          displayName: artifact.declaration.displayName,
          sha256: exported.sha256,
          sizeBytes: exported.byteLength,
          mimeType: exported.mimeType,
          handle: stableArtifactHandle(input.job.id, index),
          backend
        });
      }
      assertNotAborted(input.signal);
    } catch (error) {
      await rollbackPublishedArtifacts(publishedTargets);
      throw error;
    }
    const safeResult = withoutWorkerArtifacts(input.result, sensitivePaths);
    let committed = false;
    return {
      result: {
        ...safeResult,
        artifacts: published
      },
      commit() {
        committed = true;
        publishedTargets.length = 0;
      },
      async rollback() {
        if (committed) return;
        await rollbackPublishedArtifacts(publishedTargets);
      }
    };
  } finally {
    const releases = await Promise.allSettled(
      validated.map(({ cached }) => input.cache.endActiveTask(cached.cacheKey))
    );
    if (releases.some((release) => release.status === "rejected")) {
      await rollbackPublishedArtifacts(publishedTargets);
      throw codexArtifactError("codex_artifact_cache_release_failed");
    }
  }
}

function completedFinalization(result: CodexToolResult): CodexResultFinalization {
  return {
    result,
    commit() {},
    async rollback() {}
  };
}

function trackedPublisher(
  publisher: ChatMediaPublisher,
  publishedTargets: PublishedCodexArtifact[]
): ChatMediaPublisher {
  return {
    async publish(input) {
      const deduplicated = await publisher.publish(input);
      if (!deduplicated) {
        const target = await fs.lstat(input.targetPath, { bigint: true });
        if (
          !target.isFile()
          || target.isSymbolicLink()
          || target.nlink !== 1n
          || target.size !== BigInt(input.expectedByteLength)
        ) {
          throw codexArtifactError("codex_artifact_publish_conflict");
        }
        publishedTargets.push({
          filePath: input.targetPath,
          parentIdentity: input.parentIdentity,
          expectedTarget: target
        });
      }
      return deduplicated;
    }
  };
}

async function rollbackPublishedArtifacts(
  publishedTargets: PublishedCodexArtifact[]
) {
  let rollbackError: unknown;
  while (publishedTargets.length) {
    const published = publishedTargets.pop()!;
    try {
      await parentBoundUnlink({
        filePath: published.filePath,
        parentIdentity: published.parentIdentity,
        expectedTarget: published.expectedTarget,
        allowParentCtimeChange: true
      });
    } catch (error) {
      rollbackError ??= error;
    }
  }
  if (rollbackError) throw codexArtifactError("codex_artifact_rollback_failed");
}

function cachedArtifactAttachment(
  jobId: string,
  index: number,
  artifact: ValidatedCodexArtifact
): ParsedAttachment {
  const detectedMimeType = normalizeMimeType(artifact.declaration.mimeType);
  return {
    id: internalArtifactHandle(jobId, index),
    source: "message",
    name: artifact.declaration.displayName,
    status: "pending",
    parseStatus: "not_started",
    sizeBytes: artifact.cached.sizeBytes,
    sha256: artifact.cached.sha256,
    cacheKey: artifact.cached.cacheKey,
    ...(detectedMimeType ? { mimeType: detectedMimeType } : {}),
    acquisition: {
      status: "acquired",
      blob: {
        schemaVersion: 1,
        cacheKey: artifact.cached.cacheKey,
        sha256: artifact.cached.sha256,
        sizeBytes: artifact.cached.sizeBytes,
        ...(detectedMimeType ? { detectedMimeType } : {})
      }
    }
  };
}

function validateDeclaration(value: CodexResultArtifactV1): CodexResultArtifactV1 {
  if (
    !value
    || typeof value !== "object"
    || value.schemaVersion !== 1
    || value.handle !== undefined
    || value.backend !== undefined
    || !SHA256_PATTERN.test(value.sha256)
    || !Number.isSafeInteger(value.sizeBytes)
    || value.sizeBytes < 1
    || value.sizeBytes > MAX_CODEX_ARTIFACT_BYTES
  ) {
    throw codexArtifactError("codex_artifact_declaration_invalid");
  }
  const relativePath = safeRelativePath(value.relativePath);
  const displayName = safeDisplayName(value.displayName);
  const mimeType = normalizeMimeType(value.mimeType);
  if (value.mimeType !== undefined && !mimeType) {
    throw codexArtifactError("codex_artifact_declaration_invalid");
  }
  return {
    schemaVersion: 1,
    relativePath,
    displayName,
    sha256: value.sha256,
    sizeBytes: value.sizeBytes,
    ...(mimeType ? { mimeType } : {})
  };
}

async function resolveJobDirectory(jobRoot: string, jobId: string) {
  const realRoot = await fs.realpath(path.resolve(jobRoot));
  const candidate = path.resolve(realRoot, jobId);
  assertWithin(realRoot, candidate);
  const realJobDir = await fs.realpath(candidate);
  if (realJobDir !== candidate) throw codexArtifactError("codex_artifact_job_invalid");
  const stat = await fs.lstat(realJobDir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw codexArtifactError("codex_artifact_job_invalid");
  }
  return realJobDir;
}

async function resolveArtifactSource(
  jobDir: string,
  relativePath: string,
  job: CodexResultFinalizationInput["job"]
) {
  const parts = relativePath.split("/");
  if (
    parts.length < 4
    || parts[0] !== ".codex-worker"
    || parts[1] !== workerAttemptDirectoryName(job)
    || parts[2] !== "outputs"
  ) {
    throw codexArtifactError("codex_artifact_path_invalid");
  }
  const outputRoot = path.resolve(jobDir, ...parts.slice(0, 3));
  assertWithin(jobDir, outputRoot);
  const realOutputRoot = await fs.realpath(outputRoot);
  const outputStat = await fs.lstat(outputRoot);
  if (
    realOutputRoot !== outputRoot
    || !outputStat.isDirectory()
    || outputStat.isSymbolicLink()
  ) {
    throw codexArtifactError("codex_artifact_source_unsafe");
  }
  const candidate = path.resolve(outputRoot, ...parts.slice(3));
  assertWithin(outputRoot, candidate);
  const realPath = await fs.realpath(candidate);
  if (realPath !== candidate) throw codexArtifactError("codex_artifact_source_unsafe");
  const stat = await fs.lstat(candidate);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    throw codexArtifactError("codex_artifact_source_unsafe");
  }
  return candidate;
}

async function verifyArtifactSource(
  filePath: string,
  declaration: CodexResultArtifactV1,
  signal: AbortSignal
) {
  const handle = await fs.open(
    filePath,
    requiredFlag("O_RDONLY") | requiredFlag("O_NOFOLLOW")
  );
  try {
    const before = await handle.stat({ bigint: true });
    if (
      !before.isFile()
      || before.nlink !== 1n
      || before.size !== BigInt(declaration.sizeBytes)
      || before.size < 1n
      || before.size > BigInt(MAX_CODEX_ARTIFACT_BYTES)
    ) {
      throw codexArtifactError("codex_artifact_source_changed");
    }
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let sizeBytes = 0;
    while (true) {
      assertNotAborted(signal);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      sizeBytes += bytesRead;
      if (sizeBytes > declaration.sizeBytes) {
        throw codexArtifactError("codex_artifact_source_changed");
      }
      hash.update(buffer.subarray(0, bytesRead));
    }
    const after = await handle.stat({ bigint: true });
    if (
      before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || before.ctimeNs !== after.ctimeNs
      || before.mtimeNs !== after.mtimeNs
      || before.nlink !== after.nlink
      || sizeBytes !== declaration.sizeBytes
      || hash.digest("hex") !== declaration.sha256
    ) {
      throw codexArtifactError("codex_artifact_source_changed");
    }
  } finally {
    await handle.close();
  }
}

function withoutWorkerArtifacts(
  result: CodexToolResult,
  sensitivePaths: readonly string[]
): CodexToolResult {
  const { artifacts: _artifacts, resultFile: _resultFile, ...safeResult } = result;
  return {
    ...safeResult,
    ...(safeResult.content
      ? { content: redactCodexSensitivePaths(safeResult.content, sensitivePaths) }
      : {}),
    ...(safeResult.question
      ? { question: redactCodexSensitivePaths(safeResult.question, sensitivePaths) }
      : {}),
    ...(safeResult.stderr
      ? { stderr: redactCodexSensitivePaths(safeResult.stderr, sensitivePaths) }
      : {}),
    ...(safeResult.error
      ? {
          error: {
            ...safeResult.error,
            message: redactCodexSensitivePaths(safeResult.error.message, sensitivePaths)
          }
        }
      : {})
  };
}

function readFrozenBackend(value: unknown): AgentWorkbenchBackend | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw codexArtifactError("codex_artifact_backend_invalid");
  }
  const backend = (value as Record<string, unknown>).__sunabot_artifact_backend;
  if (backend === undefined) return undefined;
  if (backend !== "native" && backend !== "docker") {
    throw codexArtifactError("codex_artifact_backend_invalid");
  }
  return backend;
}

function safeRelativePath(value: unknown) {
  if (
    typeof value !== "string"
    || !value
    || value.length > 1_024
    || value.includes("\0")
    || value.includes("\\")
    || path.posix.isAbsolute(value)
    || path.win32.isAbsolute(value)
    || value.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw codexArtifactError("codex_artifact_path_invalid");
  }
  return value;
}

function safeDisplayName(value: unknown) {
  if (
    typeof value !== "string"
    || !value
    || value.length > 180
    || /[\u0000-\u001f\u007f/\\]/u.test(value)
    || value.trim() !== value
    || path.posix.basename(value) !== value
    || path.win32.basename(value) !== value
  ) {
    throw codexArtifactError("codex_artifact_name_invalid");
  }
  return value;
}

function normalizeMimeType(value: unknown) {
  if (value === undefined) return undefined;
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  return /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,127}$/u.test(normalized)
    ? normalized
    : undefined;
}

function internalArtifactHandle(jobId: string, index: number) {
  return `codex-worker:${jobId}:artifact:${index}`;
}

function stableArtifactHandle(jobId: string, index: number) {
  return `codex:${jobId}:artifact:${index}`;
}

function artifactPublicationPrefix(job: CodexResultFinalizationInput["job"]) {
  const attemptDirectory = workerAttemptDirectoryName(job);
  const identity = `${job.id}\0${attemptDirectory}`;
  return `codex-${createHash("sha256").update(identity).digest("hex").slice(0, 24)}`;
}

function workerAttemptDirectoryName(job: CodexResultFinalizationInput["job"]) {
  if (
    !Number.isSafeInteger(job.attempts)
    || job.attempts < 1
    || typeof job.attemptToken !== "string"
    || !/^[A-Za-z0-9_-]{1,128}$/u.test(job.attemptToken)
  ) {
    throw codexArtifactError("codex_artifact_attempt_invalid");
  }
  return `attempt-${job.attempts}-${job.attemptToken}`;
}

function assertWithin(root: string, candidate: string) {
  const relative = path.relative(root, candidate);
  if (
    relative === ""
    || relative === ".."
    || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative)
  ) {
    throw codexArtifactError("codex_artifact_path_invalid");
  }
}

function assertNotAborted(signal: AbortSignal) {
  if (signal.aborted) {
    throw signal.reason ?? codexArtifactError("codex_artifact_cancelled");
  }
}

function requiredFlag(name: "O_RDONLY" | "O_NOFOLLOW") {
  const value = (fsConstants as unknown as Record<string, number>)[name];
  if (
    typeof value !== "number"
    || !Number.isSafeInteger(value)
    || value < 0
    || (name === "O_NOFOLLOW" && value === 0)
  ) {
    throw codexArtifactError("codex_artifact_platform_unsupported");
  }
  return value;
}

function codexArtifactError(code: string) {
  return Object.assign(new Error(code), { code });
}
