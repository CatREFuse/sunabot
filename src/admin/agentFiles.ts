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

const MAX_AGENT_FILE_BYTES = 256 * 1024;

export class AgentFileRepository {
  private readonly mutex: AdminMutationMutex;
  private readonly recoveryState: AdminRecoveryState;

  constructor(private readonly options: AgentFileRepositoryOptions) {
    this.mutex = options.mutex ?? adminMutationMutex;
    this.recoveryState = options.recoveryState ?? adminRecoveryState;
  }

  async validateConfig(config: AppConfig) {
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
  const bytes = Buffer.byteLength(body.content, "utf8");
  if (bytes > MAX_AGENT_FILE_BYTES) {
    throw new AdminApiError(413, "AGENT_FILE_TOO_LARGE", "Agent 文件超过 256 KiB 限制。", "content");
  }
  if (!definition.allowBlank && !body.content.trim()) {
    badRequest("AGENT_FILE_EMPTY", "运行提示词不能为空白。", "content");
  }
  try {
    validatePromptContent(definition.kind, body.content);
  } catch (error) {
    if (error instanceof PromptTemplateError) {
      badRequest(error.code, error.message, error.field ?? "content");
    }
    throw error;
  }
  const availableVariables = new Set(definition.variables.map((variable) => variable.name));
  const unknownVariable = extractPromptVariables(body.content).find((name) => !availableVariables.has(name));
  if (unknownVariable) {
    badRequest(
      "PROMPT_VARIABLE_UNKNOWN",
      `当前提示词不能直接使用变量：${unknownVariable}`,
      unknownVariable
    );
  }
  if (definition.kind === "final") {
    const variableTypes = new Map(definition.variables.map((variable) => [variable.name, variable.type]));
    const invalidMessageGroup = parseFinalPromptTemplate(body.content).messages
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
  return { content: body.content, revision: body.revision.trim() };
}

async function atomicWrite(filePath: string, content: string) {
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.rollback.tmp`;
  await fs.writeFile(temporaryPath, content, { encoding: "utf8", mode: 0o600 });
  await fs.rename(temporaryPath, filePath);
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
