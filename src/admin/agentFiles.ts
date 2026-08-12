import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { loadConfig, resolveProjectPath } from "../config.js";
import { PROMPT_FILE_DEFINITIONS, type PromptFileDefinition } from "../../services/agent/promptCatalog.js";
import {
  extractPromptVariables,
  parseFinalPromptTemplate,
  PromptTemplateError,
  validatePromptContent
} from "../../services/agent/promptSystem.js";
import type { AppConfig } from "../types.js";
import type { PromptWorkspaceScope } from "../../services/agent/promptWorkspace.js";
import {
  AGENT_FILE_BATCH_TRANSACTION_FILE,
  cleanupBatchArtifacts,
  createBatchTransactionJournal,
  durableAtomicWrite,
  durableWriteFile,
  finishCommittedBatchTransaction,
  readBatchTransactionJournal,
  readTransactionArtifact,
  removeBatchTransactionJournal,
  sha256Content,
  syncDirectories,
  syncDirectory,
  writeBatchTransactionJournal
} from "./agentFileBatchTransaction.js";
import { AdminApiError, badRequest, conflict, notFound } from "./errors.js";
import {
  adminMutationMutex,
  adminRecoveryState,
  type AdminMutationMutex,
  type AdminRecoveryState
} from "./mutation.js";

export const AGENT_FILE_DEFINITIONS = PROMPT_FILE_DEFINITIONS;

type AgentFileDefinition = PromptFileDefinition;

interface ResolvedAgentFile {
  definition: AgentFileDefinition;
  workspacePath: string;
  filePath: string;
  fileName: string;
}

interface AgentFileConfigSnapshot {
  id: string;
  filePath: string;
  revision: string;
}

export interface AgentFileRuntime {
  reloadPrompts(config: AppConfig): Promise<void>;
  preparePromptReload?(id: string, content: string, config: AppConfig): Promise<unknown>;
  commitPromptReload?(snapshot: unknown): void;
  defaultPromptContent?(id: string): string;
}

export interface AgentFileRepositoryOptions {
  runtime: AgentFileRuntime;
  mutex?: AdminMutationMutex;
  recoveryState?: AdminRecoveryState;
}

export interface AgentFileBatchEntry {
  id: string;
  content: string;
}

export interface AgentFileBatchSnapshotFile {
  id: string;
  fileName: string;
  kind: "fragment" | "final";
  content: string;
  revision: string;
}

export interface AgentFileBatchSnapshot {
  revision: string;
  files: AgentFileBatchSnapshotFile[];
}

const MAX_AGENT_FILE_BYTES = 256 * 1024;
export { AGENT_FILE_BATCH_TRANSACTION_FILE } from "./agentFileBatchTransaction.js";

export async function recoverAgentFileBatchTransactions(config: AppConfig) {
  await adminMutationMutex.runExclusive(async () => {
    for (const scope of ["persona", "system"] satisfies PromptWorkspaceScope[]) {
      await recoverBatchTransactionUnlocked(config, scope);
    }
  });
}

export class AgentFileRepository {
  private readonly mutex: AdminMutationMutex;
  private readonly recoveryState: AdminRecoveryState;

  constructor(private readonly options: AgentFileRepositoryOptions) {
    this.mutex = options.mutex ?? adminMutationMutex;
    this.recoveryState = options.recoveryState ?? adminRecoveryState;
  }

  async validateConfig(config: AppConfig) {
    await this.recoverBatchTransaction(config, "persona");
    await this.recoverBatchTransaction(config, "system");
    await Promise.all(AGENT_FILE_DEFINITIONS.map((definition) => resolveAgentFile(config, definition)));
  }

  async captureConfigRevisions(config: AppConfig): Promise<AgentFileConfigSnapshot[]> {
    return Promise.all(AGENT_FILE_DEFINITIONS.map(async (definition) => {
      const resolved = await resolveAgentFile(config, definition);
      const state = await readFileState(resolved);
      return { id: definition.id, filePath: resolved.filePath, revision: state.revision };
    }));
  }

  async assertConfigRevisions(config: AppConfig, snapshot: AgentFileConfigSnapshot[]) {
    for (const expected of snapshot) {
      const resolved = await resolveAgentFile(config, definitionById(expected.id));
      const state = await readFileState(resolved);
      if (resolved.filePath !== expected.filePath || state.revision !== expected.revision) {
        throw new AdminApiError(409, "AGENT_FILES_CHANGED", "Agent 文件已在配置准备期间修改，请重新保存。");
      }
    }
  }

  async list(config?: AppConfig, scope?: PromptWorkspaceScope) {
    const activeConfig = config ?? await loadConfig();
    const definitions = scope
      ? AGENT_FILE_DEFINITIONS.filter((definition) => definition.scope === scope)
      : AGENT_FILE_DEFINITIONS;
    return {
      files: await Promise.all(definitions.map(async (definition) => {
        const resolved = await resolveAgentFile(activeConfig, definition);
        const state = withRuntimeDefault(await readFileState(resolved), definition, this.options.runtime);
        return publicMetadata(resolved, state);
      }))
    };
  }

  async get(id: string, config?: AppConfig) {
    const activeConfig = config ?? await loadConfig();
    const resolved = await resolveAgentFile(activeConfig, definitionById(id));
    const state = withRuntimeDefault(await readFileState(resolved), resolved.definition, this.options.runtime);
    return {
      ...publicMetadata(resolved, state),
      content: state.content
    };
  }

  async readBatch(config: AppConfig, scope: PromptWorkspaceScope): Promise<AgentFileBatchSnapshot> {
    return this.mutex.runExclusive(async () => {
      await this.recoverBatchTransaction(config, scope);
      return this.readBatchUnlocked(config, scope);
    });
  }

  async inspectBatch(
    entries: readonly AgentFileBatchEntry[],
    config: AppConfig,
    scope: PromptWorkspaceScope
  ): Promise<AgentFileBatchSnapshot> {
    return this.mutex.runExclusive(async () => {
      await this.recoverBatchTransaction(config, scope);
      validateBatchEntries(entries, scope);
      return this.readBatchUnlocked(config, scope);
    });
  }

  async putBatch(
    entries: readonly AgentFileBatchEntry[],
    expectedRevision: string,
    config: AppConfig,
    scope: PromptWorkspaceScope,
    signal?: AbortSignal
  ): Promise<AgentFileBatchSnapshot> {
    signal?.throwIfAborted();
    return this.mutex.runExclusive(async () => {
      signal?.throwIfAborted();
      await this.recoverBatchTransaction(config, scope);
      const recoveryError = this.recoveryState.get();
      if (recoveryError) throw new AdminApiError(503, "CONFIG_RECOVERY_REQUIRED", recoveryError);
      const validated = validateBatchEntries(entries, scope);

      const currentBatch = await this.readBatchUnlocked(config, scope);
      const targets = await Promise.all(validated.map(async ({ definition, content }) => {
        const resolved = await resolveAgentFile(config, definition);
        const current = await readFileState(resolved);
        return { resolved, current, content };
      }));
      const currentRevision = currentBatch.revision;
      if (!expectedRevision || expectedRevision !== currentRevision) {
        conflict("AGENT_FILE_BATCH_REVISION_CONFLICT", "人格文件已被其他操作修改，请重新预览。", currentRevision);
      }

      for (const target of targets) await ensureSafeParent(target.resolved);
      const latestRevision = (await this.readBatchUnlocked(config, scope)).revision;
      if (latestRevision !== currentRevision) {
        conflict("AGENT_FILE_BATCH_REVISION_CONFLICT", "人格文件已在准备期间修改，请重新预览。", latestRevision);
      }

      const transactionId = crypto.randomBytes(12).toString("hex");
      const staged = targets.map((target) => ({
        ...target,
        temporaryPath: path.join(
          path.dirname(target.resolved.filePath),
          `.${path.basename(target.resolved.filePath)}.${transactionId}.tmp`
        ),
        backupPath: path.join(
          path.dirname(target.resolved.filePath),
          `.${path.basename(target.resolved.filePath)}.${transactionId}.admin-backup`
        )
      }));
      const journalPath = path.join(staged[0]?.resolved.workspacePath ?? await workspacePathForScope(config, scope), AGENT_FILE_BATCH_TRANSACTION_FILE);
      const journal = createBatchTransactionJournal({
        transactionId,
        phase: "prepared",
        scope,
        targets: staged.map((target) => ({
          id: target.resolved.definition.id,
          fileName: target.resolved.fileName,
          existed: target.current.exists,
          ...(target.current.exists ? { originalSha256: sha256Content(target.current.content) } : {}),
          nextSha256: sha256Content(target.content)
        }))
      });
      let commitStarted = false;
      let commitRecorded = false;
      try {
        for (const target of staged) {
          await durableWriteFile(target.temporaryPath, target.content, true);
          if (target.current.exists) {
            await durableWriteFile(target.backupPath, target.current.content, true);
          }
          signal?.throwIfAborted();
        }
        const beforeCommitRevision = (await this.readBatchUnlocked(config, scope)).revision;
        if (beforeCommitRevision !== currentRevision) {
          conflict("AGENT_FILE_BATCH_REVISION_CONFLICT", "人格文件已在提交前修改，请重新预览。", beforeCommitRevision);
        }

        await writeBatchTransactionJournal(journalPath, journal);
        const afterJournalRevision = (await this.readBatchUnlocked(config, scope)).revision;
        if (afterJournalRevision !== currentRevision) {
          conflict("AGENT_FILE_BATCH_REVISION_CONFLICT", "人格文件已在事务准备期间修改，请重新预览。", afterJournalRevision);
        }

        commitStarted = true;
        for (const target of staged) {
          signal?.throwIfAborted();
          await fs.rename(target.temporaryPath, target.resolved.filePath);
        }
        await syncDirectories(staged.map((target) => path.dirname(target.resolved.filePath)));
        await this.options.runtime.reloadPrompts(config);
        signal?.throwIfAborted();
        await writeBatchTransactionJournal(journalPath, { ...journal, phase: "committed" });
        commitRecorded = true;
        await finishCommittedBatchTransaction(journalPath, staged);
        return this.readBatchUnlocked(config, scope);
      } catch (error) {
        if (commitRecorded) {
          try {
            await recoverBatchTransactionUnlocked(config, scope);
          } catch (cleanupError) {
            const message = `人格文件批量提交已完成，但事务清理失败。${errorMessage(cleanupError)}`;
            this.recoveryState.requireRecovery(message);
            throw new AdminApiError(503, "CONFIG_RECOVERY_REQUIRED", message);
          }
          return this.readBatchUnlocked(config, scope);
        }
        if (!commitStarted) {
          try {
            await cleanupBatchArtifacts(staged);
            await removeBatchTransactionJournal(journalPath);
          } catch (cleanupError) {
            const message = `人格文件批量准备失败且临时文件清理失败。${errorMessage(cleanupError)}`;
            this.recoveryState.requireRecovery(message);
            throw new AdminApiError(503, "CONFIG_RECOVERY_REQUIRED", message);
          }
          throw error;
        }
        try {
          const recovered = await recoverBatchTransactionUnlocked(config, scope);
          if (recovered === "committed") {
            return this.readBatchUnlocked(config, scope);
          }
          if (recovered !== "rolled-back") {
            throw new Error("人格文件事务状态缺失。");
          }
          await this.options.runtime.reloadPrompts(config);
        } catch (rollbackError) {
          const message = `人格文件批量提交失败且自动恢复失败。${errorMessage(rollbackError)}`;
          this.recoveryState.requireRecovery(message);
          throw new AdminApiError(503, "CONFIG_RECOVERY_REQUIRED", message);
        }
        throw error;
      }
    });
  }

  private async recoverBatchTransaction(config: AppConfig, scope: PromptWorkspaceScope) {
    try {
      const outcome = await recoverBatchTransactionUnlocked(config, scope);
      if (outcome) await this.options.runtime.reloadPrompts(config);
    } catch (error) {
      const message = `人格文件事务自动恢复失败。${errorMessage(error)}`;
      this.recoveryState.requireRecovery(message);
      throw new AdminApiError(503, "CONFIG_RECOVERY_REQUIRED", message);
    }
  }

  async put(id: string, body: unknown, config?: AppConfig, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const definition = definitionById(id);
    const request = parseWriteRequest(body, definition);

    return this.mutex.runExclusive(async () => {
      signal?.throwIfAborted();
      const recoveryError = this.recoveryState.get();
      if (recoveryError) {
        throw new AdminApiError(503, "CONFIG_RECOVERY_REQUIRED", recoveryError);
      }
      const activeConfig = config ?? await loadConfig();
      signal?.throwIfAborted();
      const resolved = await resolveAgentFile(activeConfig, definition);
      signal?.throwIfAborted();
      const current = await readFileState(resolved);
      signal?.throwIfAborted();
      if (request.revision !== current.revision) {
        conflict("AGENT_FILE_REVISION_CONFLICT", "文件已被其他操作修改，请重新载入。", current.revision);
      }

      await ensureSafeParent(resolved);
      signal?.throwIfAborted();
      const latest = await readFileState(resolved);
      signal?.throwIfAborted();
      if (latest.revision !== current.revision) {
        conflict("AGENT_FILE_REVISION_CONFLICT", "文件已在外部修改，请重新载入。", latest.revision);
      }

      const reloadRuntime = definition.scope === "persona";
      const preparedPrompt = reloadRuntime && this.options.runtime.preparePromptReload
        ? await this.options.runtime.preparePromptReload(id, request.content, activeConfig)
        : undefined;
      signal?.throwIfAborted();

      const temporaryPath = path.join(
        path.dirname(resolved.filePath),
        `.${path.basename(resolved.filePath)}.${process.pid}.${Date.now()}.tmp`
      );
      const backupPath = `${resolved.filePath}.admin-backup`;
      let backupWritten = false;
      try {
        await fs.writeFile(temporaryPath, request.content, { encoding: "utf8", mode: 0o600, flag: "wx" });
        signal?.throwIfAborted();
        const beforeBackup = await readFileState(resolved);
        signal?.throwIfAborted();
        if (beforeBackup.revision !== current.revision) {
          conflict("AGENT_FILE_REVISION_CONFLICT", "文件已在准备期间修改，请重新载入。", beforeBackup.revision);
        }
        if (current.exists) {
          await atomicWrite(backupPath, current.content);
          backupWritten = true;
          signal?.throwIfAborted();
        }
        const beforeRename = await readFileState(resolved);
        signal?.throwIfAborted();
        if (beforeRename.revision !== current.revision) {
          conflict("AGENT_FILE_REVISION_CONFLICT", "文件已在提交前修改，请重新载入。", beforeRename.revision);
        }
      } catch (error) {
        await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
        if (backupWritten) await fs.rm(backupPath, { force: true }).catch(() => undefined);
        throw error;
      }
      try {
        signal?.throwIfAborted();
        await fs.rename(temporaryPath, resolved.filePath);
        signal?.throwIfAborted();
        if (reloadRuntime) {
          if (preparedPrompt !== undefined && this.options.runtime.commitPromptReload) {
            this.options.runtime.commitPromptReload(preparedPrompt);
          } else {
            await this.options.runtime.reloadPrompts(activeConfig);
          }
        }
        signal?.throwIfAborted();
        await fs.rm(backupPath, { force: true }).catch(() => undefined);
        const saved = await readFileState(resolved);
        signal?.throwIfAborted();
        return {
          ok: true,
          ...publicMetadata(resolved, saved),
          content: saved.content
        };
      } catch (error) {
        await fs.rm(temporaryPath, { force: true });
        try {
          if (current.exists) {
            await atomicWrite(resolved.filePath, current.content);
          } else {
            await fs.rm(resolved.filePath, { force: true });
          }
          if (reloadRuntime) await this.options.runtime.reloadPrompts(activeConfig);
          await fs.rm(backupPath, { force: true }).catch(() => undefined);
        } catch (rollbackError) {
          const message = `提示词提交失败且自动恢复失败。备份：${backupPath}。${errorMessage(rollbackError)}`;
          this.recoveryState.requireRecovery(message);
          throw new AdminApiError(503, "CONFIG_RECOVERY_REQUIRED", message);
        }
        throw error;
      }
    });
  }

  private async readBatchUnlocked(config: AppConfig, scope: PromptWorkspaceScope): Promise<AgentFileBatchSnapshot> {
    const definitions = AGENT_FILE_DEFINITIONS.filter((definition) => definition.scope === scope);
    const files = await Promise.all(definitions.map(async (definition) => {
      const resolved = await resolveAgentFile(config, definition);
      const state = withRuntimeDefault(await readFileState(resolved), definition, this.options.runtime);
      return {
        id: definition.id,
        fileName: resolved.fileName,
        kind: definition.kind,
        content: state.content,
        revision: state.revision
      } satisfies AgentFileBatchSnapshotFile;
    }));
    return {
      revision: batchRevision(files.map(({ id, revision }) => ({ id, revision }))),
      files
    };
  }
}

function definitionById(id: string) {
  const definition = AGENT_FILE_DEFINITIONS.find((item) => item.id === id);
  if (!definition) notFound("AGENT_FILE_NOT_FOUND", "Agent 文件不存在。");
  return definition;
}

async function resolveAgentFile(config: AppConfig, definition: AgentFileDefinition): Promise<ResolvedAgentFile> {
  const workspaceField = definition.scope === "system" ? "systemPromptWorkspace" : "agentWorkspace";
  const configuredWorkspace = resolveProjectPath(config.persona[workspaceField]);
  if (!configuredWorkspace) {
    badRequest(
      "AGENT_WORKSPACE_INVALID",
      definition.scope === "system" ? "系统提示词 workspace 未配置。" : "Agent workspace 未配置。",
      `persona.${workspaceField}`
    );
  }
  let workspacePath = path.resolve(configuredWorkspace);
  try {
    const stats = await fs.stat(configuredWorkspace);
    if (!stats.isDirectory()) {
      badRequest(
        "AGENT_WORKSPACE_INVALID",
        definition.scope === "system" ? "系统提示词 workspace 不是目录。" : "Agent workspace 不是目录。",
        `persona.${workspaceField}`
      );
    }
    workspacePath = await fs.realpath(configuredWorkspace);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const fileName = definition.fileName(config).trim();
  assertSafeRelativePath(fileName);
  const filePath = path.resolve(workspacePath, fileName);
  assertInside(workspacePath, filePath);
  await assertExistingPathInsideWorkspace(workspacePath, filePath);
  return { definition, workspacePath, filePath, fileName };
}

function assertSafeRelativePath(value: string) {
  if (!value || value.includes("\0") || path.isAbsolute(value)) {
    badRequest("AGENT_FILE_PATH_INVALID", "Agent 文件路径无效。");
  }
  const root = path.resolve("/agent-workspace");
  const resolved = path.resolve(root, value);
  if (resolved === root || !resolved.startsWith(`${root}${path.sep}`)) {
    badRequest("AGENT_FILE_PATH_INVALID", "Agent 文件路径不能离开 workspace。");
  }
}

async function assertExistingPathInsideWorkspace(workspacePath: string, filePath: string) {
  const relative = path.relative(workspacePath, filePath);
  let cursor = workspacePath;
  for (const segment of relative.split(path.sep)) {
    cursor = path.join(cursor, segment);
    try {
      const stats = await fs.lstat(cursor);
      if (!stats.isSymbolicLink()) continue;
      const target = await fs.realpath(cursor);
      assertInside(workspacePath, target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }
  try {
    assertInside(workspacePath, await fs.realpath(filePath));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function ensureSafeParent(resolved: ResolvedAgentFile) {
  await assertExistingPathInsideWorkspace(resolved.workspacePath, resolved.filePath);
  await fs.mkdir(path.dirname(resolved.filePath), { recursive: true });
  const realParent = await fs.realpath(path.dirname(resolved.filePath));
  assertInside(resolved.workspacePath, realParent);
  await assertExistingPathInsideWorkspace(resolved.workspacePath, resolved.filePath);
}

function assertInside(root: string, candidate: string) {
  if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) {
    badRequest("AGENT_FILE_PATH_INVALID", "Agent 文件路径不能离开 workspace。");
  }
}

async function readFileState(resolved: ResolvedAgentFile) {
  let bytes = Buffer.alloc(0);
  let modifiedAt: string | undefined;
  let exists = false;
  let revisionPath = resolved.filePath;
  try {
    const stats = await fs.stat(resolved.filePath);
    if (!stats.isFile()) badRequest("AGENT_FILE_PATH_INVALID", "Agent 文件路径不是普通文件。");
    if (stats.size > MAX_AGENT_FILE_BYTES) {
      throw new AdminApiError(413, "AGENT_FILE_TOO_LARGE", "Agent 文件超过 256 KiB 限制。");
    }
    bytes = await fs.readFile(resolved.filePath);
    if (bytes.byteLength > MAX_AGENT_FILE_BYTES) {
      throw new AdminApiError(413, "AGENT_FILE_TOO_LARGE", "Agent 文件超过 256 KiB 限制。");
    }
    revisionPath = await fs.realpath(resolved.filePath);
    modifiedAt = stats.mtime.toISOString();
    exists = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  let content: string;
  try {
    content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new AdminApiError(422, "AGENT_FILE_INVALID_UTF8", "Agent 文件不是有效 UTF-8 文本。");
  }
  return {
    content,
    exists,
    modifiedAt,
    revision: agentFileRevision(resolved.workspacePath, revisionPath, bytes)
  };
}

function agentFileRevision(workspacePath: string, filePath: string, content: Uint8Array) {
  const hash = crypto.createHash("sha256");
  hash.update(workspacePath, "utf8");
  hash.update("\0");
  hash.update(filePath, "utf8");
  hash.update("\0");
  hash.update(content);
  return hash.digest("hex");
}

function publicMetadata(resolved: ResolvedAgentFile, state: Awaited<ReturnType<typeof readFileState>>) {
  return {
    id: resolved.definition.id,
    title: resolved.definition.title,
    category: resolved.definition.category,
    kind: resolved.definition.kind,
    variables: resolved.definition.variables,
    fileName: resolved.fileName,
    updatedAt: state.modifiedAt,
    revision: state.revision,
    empty: state.content.trim().length === 0
  };
}

function withRuntimeDefault(
  state: Awaited<ReturnType<typeof readFileState>>,
  definition: AgentFileDefinition,
  runtime: AgentFileRuntime
) {
  if (state.exists) return state;
  const fallback = runtime.defaultPromptContent?.(definition.id) ?? "";
  return fallback ? { ...state, content: `${fallback.trim()}\n` } : state;
}

function parseWriteRequest(input: unknown, definition: AgentFileDefinition) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    badRequest("AGENT_FILE_INVALID", "请求体必须是对象。");
  }
  const body = input as Record<string, unknown>;
  const extra = Object.keys(body).find((key) => key !== "content" && key !== "revision");
  if (extra) badRequest("AGENT_FILE_INVALID", "包含不支持的字段。", extra);
  if (typeof body.content !== "string") badRequest("AGENT_FILE_INVALID", "正文必须是文本。", "content");
  if (typeof body.revision !== "string" || !body.revision.trim()) {
    badRequest("AGENT_FILE_INVALID", "revision 不能为空。", "revision");
  }
  validateAgentFileContent(definition, body.content);
  return { content: body.content, revision: body.revision.trim() };
}

function validateBatchEntries(entries: readonly AgentFileBatchEntry[], scope: PromptWorkspaceScope) {
  const ids = new Set<string>();
  return entries.map((entry) => {
    if (!entry || typeof entry.id !== "string" || typeof entry.content !== "string") {
      badRequest("AGENT_FILE_BATCH_INVALID", "人格文件批量请求无效。");
    }
    if (ids.has(entry.id)) badRequest("AGENT_FILE_BATCH_DUPLICATE", `人格文件重复：${entry.id}`);
    ids.add(entry.id);
    const definition = definitionById(entry.id);
    if (definition.scope !== scope) badRequest("AGENT_FILE_BATCH_SCOPE_INVALID", `人格文件范围无效：${entry.id}`);
    validateAgentFileContent(definition, entry.content);
    return { definition, content: entry.content };
  });
}

function validateAgentFileContent(definition: AgentFileDefinition, content: string) {
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > MAX_AGENT_FILE_BYTES) {
    throw new AdminApiError(413, "AGENT_FILE_TOO_LARGE", "Agent 文件超过 256 KiB 限制。", "content");
  }
  if (!definition.allowBlank && !content.trim()) {
    badRequest("AGENT_FILE_EMPTY", "运行提示词不能为空白。", "content");
  }
  try {
    validatePromptContent(definition.kind, content);
  } catch (error) {
    if (error instanceof PromptTemplateError) {
      badRequest(error.code, error.message, error.field ?? "content");
    }
    throw error;
  }
  const availableVariables = new Set(definition.variables.map((variable) => variable.name));
  const unknownVariable = extractPromptVariables(content).find((name) => !availableVariables.has(name));
  if (unknownVariable) {
    badRequest(
      "PROMPT_VARIABLE_UNKNOWN",
      `当前提示词不能直接使用变量：${unknownVariable}`,
      unknownVariable
    );
  }
  if (definition.kind === "final") {
    const variableTypes = new Map(definition.variables.map((variable) => [variable.name, variable.type]));
    const invalidMessageGroup = parseFinalPromptTemplate(content).messages
      .filter((message): message is string => typeof message === "string")
      .map((message) => extractPromptVariables(message)[0] ?? "")
      .find((name) => variableTypes.get(name) !== "message[]");
    if (invalidMessageGroup) {
      badRequest(
        "PROMPT_MESSAGE_GROUP_TYPE_INVALID",
        `消息组必须使用 message[] 变量：${invalidMessageGroup}`,
        invalidMessageGroup
      );
    }
  }
}

function batchRevision(entries: readonly { id: string; revision: string }[]) {
  const hash = crypto.createHash("sha256");
  for (const entry of [...entries].sort((left, right) => left.id.localeCompare(right.id))) {
    hash.update(entry.id, "utf8");
    hash.update("\0");
    hash.update(entry.revision, "utf8");
    hash.update("\0");
  }
  return hash.digest("hex");
}

async function workspacePathForScope(config: AppConfig, scope: PromptWorkspaceScope) {
  const definition = AGENT_FILE_DEFINITIONS.find((item) => item.scope === scope);
  if (!definition) throw new Error(`缺少 ${scope} Agent 文件定义。`);
  return (await resolveAgentFile(config, definition)).workspacePath;
}

async function recoverBatchTransactionUnlocked(
  config: AppConfig,
  scope: PromptWorkspaceScope
): Promise<"rolled-back" | "committed" | undefined> {
  const workspacePath = await workspacePathForScope(config, scope);
  const journalPath = path.join(workspacePath, AGENT_FILE_BATCH_TRANSACTION_FILE);
  const journal = await readBatchTransactionJournal(journalPath);
  if (!journal) return undefined;
  if (journal.scope !== scope) {
    throw new Error(`事务范围应为 ${scope}。`);
  }

  const targets = await Promise.all(journal.targets.map(async (target) => {
    const resolved = await resolveAgentFile(config, definitionById(target.id));
    if (resolved.definition.scope !== scope || resolved.fileName !== target.fileName) {
      throw new Error(`事务文件映射已变化：${target.id}。`);
    }
    return {
      ...target,
      resolved,
      temporaryPath: path.join(
        path.dirname(resolved.filePath),
        `.${path.basename(resolved.filePath)}.${journal.transactionId}.tmp`
      ),
      backupPath: path.join(
        path.dirname(resolved.filePath),
        `.${path.basename(resolved.filePath)}.${journal.transactionId}.admin-backup`
      )
    };
  }));

  if (journal.phase === "committed") {
    for (const target of targets) {
      const state = await readFileState(target.resolved);
      if (!state.exists || sha256Content(state.content) !== target.nextSha256) {
        throw new Error(`已提交事务的文件校验失败：${target.id}。`);
      }
    }
    await finishCommittedBatchTransaction(journalPath, targets);
    return "committed";
  }

  for (const target of targets) {
    const state = await readFileState(target.resolved);
    if (target.existed) {
      if (state.exists && sha256Content(state.content) === target.originalSha256) continue;
      if (state.exists && sha256Content(state.content) !== target.nextSha256) {
        throw new Error(`未提交事务的目标文件已被外部修改：${target.id}。`);
      }
      const original = await readTransactionArtifact(
        target.backupPath,
        target.originalSha256!,
        MAX_AGENT_FILE_BYTES
      );
      await durableAtomicWrite(target.resolved.filePath, original);
      continue;
    }
    if (state.exists && sha256Content(state.content) !== target.nextSha256) {
      throw new Error(`未提交事务的目标文件已被外部修改：${target.id}。`);
    }
    if (state.exists) {
      await fs.rm(target.resolved.filePath);
      await syncDirectory(path.dirname(target.resolved.filePath));
    }
  }
  await cleanupBatchArtifacts(targets);
  await removeBatchTransactionJournal(journalPath);
  return "rolled-back";
}

async function atomicWrite(filePath: string, content: string) {
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.rollback.tmp`;
  try {
    await fs.writeFile(temporaryPath, content, { encoding: "utf8", mode: 0o600 });
    await fs.rename(temporaryPath, filePath);
  } catch (error) {
    try {
      await fs.rm(temporaryPath, { force: true });
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "原子写入失败且回滚临时文件清理失败。");
    }
    throw error;
  }
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
