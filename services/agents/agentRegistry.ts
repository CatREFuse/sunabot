import fs from "node:fs/promises";
import path from "node:path";
import { nanoid } from "nanoid";
import { ServiceError } from "../../packages/contracts/errors/serviceError.js";
import { inspectMultiAgentMigrationGate, validateMultiAgentWorkspacePath } from "../../packages/platform/multiAgentMigrationGate.mjs";
import { WORKSPACE_LAYOUT, workspaceRelativeReference } from "../../packages/platform/workspaceLayout.js";
import {
  defaultPromptContent,
  PROMPT_FILE_DEFINITIONS,
  resolveSafePromptFilePath
} from "../agent/public.js";
import { getWorkspacePath, resolveProjectPath } from "../../src/config.js";
import type { AppConfig, BotConfig } from "../../src/types.js";
import type {
  AgentAccountRegistryRow,
  AgentRegistryRepository,
  AgentRegistryRow
} from "./agentRegistryRepository.js";

const MANIFEST_FILE = "agent.json";
const AGENT_ID_PATTERN = /^[a-z][a-z0-9-]{1,31}$/;

export interface AgentManifest {
  schemaVersion: 1;
  id: string;
  name: string;
  enabled: boolean;
  avatarPath?: string;
  createdAt: string;
  updatedAt: string;
  prompts: {
    overrideSystem: boolean;
  };
  bot: BotConfig;
  onebot: Pick<
    AppConfig["onebot"],
    "autoReplyPrivate" | "autoReplyUserGroup" | "autoReplyBotGroup" | "quoteGroupReplies" | "mentionNames" | "commandPrefixes"
  >;
}

export interface AgentAccount extends AgentAccountRegistryRow {
  connected?: boolean;
  selfId?: string;
  runtimeReady?: boolean;
  desiredState?: "running" | "stopped";
  observedState?: "running" | "stopped" | "missing" | "unknown";
  reconcileRequired?: boolean;
  lastError?: string | null;
}

export interface AgentSummary extends AgentRegistryRow {
  accounts: AgentAccount[];
}

export interface AgentAvatarInput {
  fileName: string;
  dataBase64: string;
}

export interface AgentRegistryOptions {
  workspaceRoot?: string;
  store: AgentRegistryRepository;
  allowUnmarkedMigration?: boolean;
  workspaceGateAlreadyChecked?: boolean;
  now?: () => Date;
}

export class AgentRegistry {
  private readonly workspaceRoot: string;
  private readonly store: AgentRegistryOptions["store"];
  private readonly allowUnmarkedMigration: boolean;
  private readonly workspaceGateAlreadyChecked: boolean;
  private readonly now: () => Date;

  constructor(private sharedConfig: AppConfig, options: AgentRegistryOptions) {
    this.workspaceRoot = options.workspaceRoot ?? getWorkspacePath(WORKSPACE_LAYOUT.agentRoot);
    this.store = options.store;
    this.allowUnmarkedMigration = options.allowUnmarkedMigration === true;
    this.workspaceGateAlreadyChecked = options.workspaceGateAlreadyChecked === true;
    this.now = options.now ?? (() => new Date());
  }

  async initialize() {
    if (!this.workspaceGateAlreadyChecked) {
      const workspace = path.resolve(this.workspaceRoot, "../..");
      if (this.allowUnmarkedMigration) {
        await validateMultiAgentWorkspacePath(workspace);
      } else if ((await inspectMultiAgentMigrationGate(workspace)).state !== "trusted") {
        throw new ServiceError(
          409,
          "MULTI_AGENT_MIGRATION_REQUIRED",
          "现有 workspace 缺少可信多 Agent 迁移标记；请先执行单 Agent 迁移。"
        );
      }
    }
    await fs.mkdir(this.workspaceRoot, { recursive: true, mode: 0o700 });
    await this.ensureDefaultAgent();
    await this.ensureSharedSystemPrompts();
  }

  updateSharedConfig(config: AppConfig) {
    this.sharedConfig = config;
  }

  async list(): Promise<AgentSummary[]> {
    const accounts = this.store.readAgentAccounts();
    return this.store.readAgents().map((agent) => ({
      ...agent,
      accounts: accounts.filter((account) => account.agentId === agent.id)
    }));
  }

  async get(agentId: string): Promise<AgentSummary> {
    const agent = this.store.readAgent(agentId);
    if (!agent) notFound("AGENT_NOT_FOUND", "Agent 不存在。");
    return { ...agent, accounts: this.store.readAgentAccounts(agent.id) };
  }

  async manifest(agentId: string): Promise<AgentManifest> {
    const agent = await this.get(agentId);
    const manifestPath = this.manifestPath(agent.id);
    let value: unknown;
    try {
      value = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new ServiceError(500, "AGENT_MANIFEST_MISSING", "Agent 配置文件不存在。");
      }
      throw error;
    }
    return parseManifest(value, agent.id);
  }

  async create(input: { id: string; name: string; avatar?: AgentAvatarInput }): Promise<AgentSummary> {
    const id = normalizeAgentId(input.id);
    const name = normalizeAgentName(input.name);
    if (this.store.readAgent(id)) conflict("AGENT_ID_CONFLICT", "Agent ID 已存在。");

    const finalDirectory = this.agentDirectory(id);
    await assertPathMissing(finalDirectory, "AGENT_WORKSPACE_CONFLICT", "Agent 工作区已存在。");
    const temporaryDirectory = await fs.mkdtemp(path.join(this.workspaceRoot, `.create-${id}-`));
    const createdAt = this.now().toISOString();
    const manifest = createManifest(this.sharedConfig, { id, name, createdAt });
    try {
      await this.writeInitialWorkspace(temporaryDirectory, manifest, input.avatar);
      await fs.rename(temporaryDirectory, finalDirectory);
      const row = manifestRow(manifest);
      try {
        this.store.createAgent(row);
      } catch (error) {
        await fs.rm(finalDirectory, { recursive: true, force: true });
        throw error;
      }
      return { ...row, accounts: [] };
    } catch (error) {
      await fs.rm(temporaryDirectory, { recursive: true, force: true });
      throw mapSqliteConflict(error);
    }
  }

  async rollbackCreatedAgent(created: Pick<AgentRegistryRow, "id" | "createdAt">) {
    const current = this.store.readAgent(created.id);
    if (!current || current.createdAt !== created.createdAt) return;

    const directory = this.agentDirectory(created.id);
    const rollbackDirectory = path.join(this.workspaceRoot, `.rollback-${created.id}-${nanoid(12)}`);
    let workspaceMoved = false;
    try {
      await fs.rename(directory, rollbackDirectory);
      workspaceMoved = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    try {
      this.store.deleteAgent(created.id);
    } catch (error) {
      if (workspaceMoved) await fs.rename(rollbackDirectory, directory);
      throw error;
    }
    if (workspaceMoved) await fs.rm(rollbackDirectory, { recursive: true, force: true });
  }

  async update(agentId: string, input: { name?: string; enabled?: boolean }): Promise<AgentSummary> {
    const current = await this.get(agentId);
    const manifest = await this.manifest(agentId);
    const updatedAt = this.now().toISOString();
    const next: AgentManifest = {
      ...manifest,
      name: input.name == null ? manifest.name : normalizeAgentName(input.name),
      enabled: input.enabled == null ? manifest.enabled : input.enabled,
      updatedAt
    };
    await atomicWriteJson(this.manifestPath(agentId), next);
    const updated = this.store.updateAgent({
      id: agentId,
      name: next.name,
      enabled: next.enabled,
      avatarPath: next.avatarPath,
      updatedAt
    });
    if (!updated) {
      await atomicWriteJson(this.manifestPath(agentId), manifest);
      notFound("AGENT_NOT_FOUND", "Agent 不存在。");
    }
    return { ...current, name: next.name, enabled: next.enabled, updatedAt };
  }

  async updateAvatar(agentId: string, input: AgentAvatarInput): Promise<AgentSummary> {
    const current = await this.get(agentId);
    const manifest = await this.manifest(agentId);
    const avatarPath = await writeAvatar(this.agentDirectory(agentId), input, `avatar-${nanoid(12)}`);
    const updatedAt = this.now().toISOString();
    const next: AgentManifest = { ...manifest, avatarPath, updatedAt };
    try {
      await atomicWriteJson(this.manifestPath(agentId), next);
      const updated = this.store.updateAgent({
        id: agentId,
        name: next.name,
        enabled: next.enabled,
        avatarPath,
        updatedAt
      });
      if (!updated) notFound("AGENT_NOT_FOUND", "Agent 不存在。");
    } catch (error) {
      await atomicWriteJson(this.manifestPath(agentId), manifest).catch(() => undefined);
      await fs.rm(path.join(this.agentDirectory(agentId), avatarPath), { force: true });
      throw error;
    }
    await removeManagedAvatar(this.agentDirectory(agentId), manifest.avatarPath).catch(() => undefined);
    return { ...current, avatarPath, updatedAt };
  }

  async createAccount(agentId: string, input: { label: string }): Promise<AgentAccount> {
    await this.get(agentId);
    const label = normalizeAccountLabel(input.label);
    const createdAt = this.now().toISOString();
    const account: AgentAccountRegistryRow = {
      id: `qq_${nanoid(12)}`,
      agentId,
      label,
      enabled: true,
      webuiPort: this.store.nextAgentAccountWebuiPort(),
      createdAt,
      updatedAt: createdAt
    };
    try {
      this.store.createAgentAccount(account);
      await ensureAccountRuntimeDirectories(account.id);
      return account;
    } catch (error) {
      this.store.deleteAgentAccount(account.id);
      throw mapSqliteConflict(error, "QQ 账号名称已存在。");
    }
  }

  async updateAccountIdentity(accountId: string, qqId: string, label?: string) {
    const current = this.store.readAgentAccount(accountId);
    if (!current) notFound("AGENT_ACCOUNT_NOT_FOUND", "QQ 账号不存在。");
    const normalizedQq = qqId.trim();
    if (!/^\d{5,20}$/.test(normalizedQq)) badRequest("QQ_ID_INVALID", "QQ 号无效。", "qqId");
    const updated = {
      ...current,
      label: label == null ? current.label : normalizeAccountLabel(label),
      qqId: normalizedQq,
      updatedAt: this.now().toISOString()
    };
    try {
      this.store.updateAgentAccount(updated);
      return updated;
    } catch (error) {
      throw mapSqliteConflict(error, "QQ 号已绑定其他 Agent。");
    }
  }

  async clearAccountIdentity(accountId: string) {
    const current = this.store.readAgentAccount(accountId);
    if (!current) notFound("AGENT_ACCOUNT_NOT_FOUND", "QQ 账号不存在。");
    const updated = {
      ...current,
      qqId: undefined,
      updatedAt: this.now().toISOString()
    };
    this.store.updateAgentAccount(updated);
    return updated;
  }

  async updateAccountEnabled(agentId: string, accountId: string, enabled: boolean) {
    const current = this.store.readAgentAccount(accountId);
    if (!current || current.agentId !== agentId) notFound("AGENT_ACCOUNT_NOT_FOUND", "QQ 账号不存在。");
    const updated = { ...current, enabled, updatedAt: this.now().toISOString() };
    this.store.updateAgentAccount(updated);
    return updated;
  }

  async removeAccount(agentId: string, accountId: string) {
    const account = this.store.readAgentAccount(accountId);
    if (!account || account.agentId !== agentId) notFound("AGENT_ACCOUNT_NOT_FOUND", "QQ 账号不存在。");
    if (account.id === "primary") conflict("PRIMARY_ACCOUNT_REQUIRED", "主账号不能移除。");
    this.store.deleteAgentAccount(account.id);
    await fs.writeFile(
      path.join(getWorkspacePath(WORKSPACE_LAYOUT.napcatAccounts, account.id), ".remove-on-stop"),
      `${this.now().toISOString()}\n`,
      { encoding: "utf8", mode: 0o600 }
    );
  }

  async config(agentId: string, sharedConfig = this.sharedConfig): Promise<AppConfig> {
    const manifest = await this.manifest(agentId);
    return configFromManifest(sharedConfig, manifest);
  }

  async promptSettings(agentId: string) {
    const manifest = await this.manifest(agentId);
    return { overrideSystem: manifest.prompts.overrideSystem };
  }

  async setSystemPromptOverride(agentId: string, enabled: boolean) {
    const previous = await this.manifest(agentId);
    if (previous.prompts.overrideSystem === enabled) return { overrideSystem: enabled };
    if (enabled) await this.ensureAgentSystemPromptOverrides(previous);
    const next: AgentManifest = {
      ...previous,
      updatedAt: this.now().toISOString(),
      prompts: { overrideSystem: enabled }
    };
    await atomicWriteJson(this.manifestPath(agentId), next);
    this.store.updateAgent({
      id: agentId,
      name: next.name,
      enabled: next.enabled,
      avatarPath: next.avatarPath,
      updatedAt: next.updatedAt
    });
    return { overrideSystem: enabled };
  }

  async saveAgentConfig(agentId: string, config: AppConfig) {
    const previous = await this.manifest(agentId);
    const updatedAt = this.now().toISOString();
    const next: AgentManifest = {
      ...previous,
      updatedAt,
      bot: structuredClone(config.bot),
      onebot: {
        autoReplyPrivate: config.onebot.autoReplyPrivate,
        autoReplyUserGroup: config.onebot.autoReplyUserGroup,
        autoReplyBotGroup: config.onebot.autoReplyBotGroup,
        quoteGroupReplies: config.bot.quoteGroupReplies,
        mentionNames: [...config.onebot.mentionNames],
        commandPrefixes: [...config.onebot.commandPrefixes]
      }
    };
    await atomicWriteJson(this.manifestPath(agentId), next);
    this.store.updateAgent({
      id: agentId,
      name: next.name,
      enabled: next.enabled,
      avatarPath: next.avatarPath,
      updatedAt
    });
    return { previous, next };
  }

  async restoreManifest(agentId: string, manifest: AgentManifest) {
    await atomicWriteJson(this.manifestPath(agentId), manifest);
    this.store.updateAgent({
      id: agentId,
      name: manifest.name,
      enabled: manifest.enabled,
      avatarPath: manifest.avatarPath,
      updatedAt: manifest.updatedAt
    });
  }

  account(accountId: string) {
    return this.store.readAgentAccount(accountId);
  }

  agentIdForQqId(qqId: string) {
    const normalized = qqId.trim();
    if (!normalized) return undefined;
    const account = this.store.readAgentAccounts().find((candidate) => (
      candidate.enabled && candidate.qqId === normalized
    ));
    if (!account) return undefined;
    const agent = this.store.readAgent(account.agentId);
    return agent?.enabled ? agent.id : undefined;
  }

  avatarFile(agentId: string) {
    const agent = this.store.readAgent(agentId);
    if (!agent) notFound("AGENT_NOT_FOUND", "Agent 不存在。");
    if (!agent.avatarPath) notFound("AGENT_AVATAR_NOT_FOUND", "Agent 头像不存在。");
    const filePath = path.resolve(this.agentDirectory(agentId), agent.avatarPath);
    assertInside(this.agentDirectory(agentId), filePath);
    return filePath;
  }

  private async ensureDefaultAgent() {
    const id = this.sharedConfig.persona.defaultAgentId || "plana";
    const directory = this.agentDirectory(id);
    const createdAt = this.now().toISOString();
    const manifestPath = this.manifestPath(id);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    let manifest: AgentManifest;
    try {
      manifest = parseManifest(JSON.parse(await fs.readFile(manifestPath, "utf8")), id);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      manifest = createManifest(this.sharedConfig, {
        id,
        name: this.sharedConfig.persona.name || "普拉娜",
        createdAt,
        avatarPath: this.sharedConfig.persona.avatarPath
      });
      await atomicWriteJson(manifestPath, manifest);
    }
    await this.ensureInitialAgentFiles(directory, manifest);
    if (!this.store.readAgent(id)) this.store.createAgent(manifestRow(manifest));
    if (id === "plana") {
      if (this.store.readAgentAccounts(id).length === 0) {
        this.store.createAgentAccount({
          id: "primary",
          agentId: id,
          label: "主账号",
          enabled: true,
          webuiPort: 6099,
          createdAt,
          updatedAt: createdAt
        });
      }
      if (this.allowUnmarkedMigration) await migrateLegacyPrimaryAccountRuntime();
      await ensureAccountRuntimeDirectories("primary");
      const primary = this.store.readAgentAccount("primary");
      if (primary && !primary.qqId) {
        const qqId = await inferPrimaryAccountQqId();
        if (qqId) {
          this.store.updateAgentAccount({ ...primary, qqId, updatedAt: this.now().toISOString() });
        }
      }
    }
  }

  private async writeInitialWorkspace(directory: string, manifest: AgentManifest, avatar?: AgentAvatarInput) {
    await fs.mkdir(path.join(directory, "assets"), { recursive: true, mode: 0o700 });
    await fs.mkdir(path.join(directory, "data"), { recursive: true, mode: 0o700 });
    await fs.mkdir(path.join(directory, "selfie"), { recursive: true, mode: 0o700 });
    await fs.mkdir(path.join(directory, "files"), { recursive: true, mode: 0o700 });
    if (avatar) manifest.avatarPath = await writeAvatar(directory, avatar);
    await atomicWriteJson(path.join(directory, MANIFEST_FILE), manifest);
    await this.ensureInitialAgentFiles(directory, manifest);
  }

  private async ensureInitialAgentFiles(directory: string, manifest: AgentManifest) {
    await Promise.all(initialAgentWorkspaceFiles(this.sharedConfig, manifest.name).map(([fileName, content]) => (
      writeIfMissing(path.join(directory, fileName), content)
    )));
  }

  private async ensureSharedSystemPrompts() {
    const sharedConfig = sharedSystemPromptConfig(this.sharedConfig);
    const defaultWorkspace = resolveProjectPath(this.sharedConfig.persona.agentWorkspace);
    await Promise.all(PROMPT_FILE_DEFINITIONS.filter((definition) => definition.scope === "system").map(async (definition) => {
      const fileName = definition.fileName(sharedConfig);
      const destination = await resolveSafePromptFilePath(sharedConfig, "system", fileName);
      const legacy = defaultWorkspace ? path.resolve(defaultWorkspace, fileName) : "";
      const content = await readOptionalText(legacy) || defaultPromptContent(definition.id, this.sharedConfig.persona.name);
      await writeIfMissing(destination, content);
    }));
  }

  private async ensureAgentSystemPromptOverrides(manifest: AgentManifest) {
    const inheritedConfig = configFromManifest(this.sharedConfig, {
      ...manifest,
      prompts: { overrideSystem: false }
    });
    const overrideConfig = configFromManifest(this.sharedConfig, {
      ...manifest,
      prompts: { overrideSystem: true }
    });
    await Promise.all(PROMPT_FILE_DEFINITIONS.filter((definition) => definition.scope === "system").map(async (definition) => {
      const fileName = definition.fileName(overrideConfig);
      const destination = await resolveSafePromptFilePath(overrideConfig, "system", fileName);
      const legacy = path.resolve(this.agentDirectory(manifest.id), fileName);
      const inherited = await resolveSafePromptFilePath(
        inheritedConfig,
        "system",
        definition.fileName(inheritedConfig)
      );
      const content = await readOptionalText(legacy)
        || await readOptionalText(inherited)
        || defaultPromptContent(definition.id, manifest.name);
      await writeIfMissing(destination, content);
    }));
  }

  private agentDirectory(agentId: string) {
    return path.join(this.workspaceRoot, agentId);
  }

  private manifestPath(agentId: string) {
    return path.join(this.agentDirectory(agentId), MANIFEST_FILE);
  }
}

export function configFromManifest(shared: AppConfig, manifest: AgentManifest): AppConfig {
  const workspace = workspaceRelativeReference(path.posix.join(WORKSPACE_LAYOUT.agentRoot, manifest.id));
  const systemPromptWorkspace = manifest.prompts.overrideSystem
    ? workspaceRelativeReference(path.posix.join(WORKSPACE_LAYOUT.agentRoot, manifest.id, "system-prompts")) : workspaceRelativeReference(WORKSPACE_LAYOUT.systemPrompts);
  const bot = structuredClone(manifest.bot);
  bot.orchestrator = { ...structuredClone(shared.bot.orchestrator), ...structuredClone(bot.orchestrator),
    groupThreadModel: manifest.id === shared.persona.defaultAgentId ? shared.bot.orchestrator.groupThreadModel : bot.orchestrator?.groupThreadModel?.trim() || shared.bot.orchestrator.groupThreadModel };
  return {
    ...structuredClone(shared),
    persona: {
      defaultAgentId: manifest.id,
      name: manifest.name,
      agentWorkspace: workspace,
      systemPromptWorkspace,
      systemPromptOverride: manifest.prompts.overrideSystem,
      ...(manifest.avatarPath ? { avatarPath: manifest.avatarPath } : {})
    },
    bot,
    onebot: {
      ...structuredClone(shared.onebot),
      ...structuredClone(manifest.onebot),
      quoteGroupReplies: bot.quoteGroupReplies
    }
  };
}
function createManifest(
  shared: AppConfig,
  input: { id: string; name: string; createdAt: string; avatarPath?: string }
): AgentManifest {
  return {
    schemaVersion: 1,
    id: input.id,
    name: input.name,
    enabled: true,
    ...(input.avatarPath ? { avatarPath: input.avatarPath } : {}),
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
    prompts: { overrideSystem: false },
    bot: structuredClone(shared.bot),
    onebot: {
      autoReplyPrivate: shared.onebot.autoReplyPrivate,
      autoReplyUserGroup: shared.onebot.autoReplyUserGroup,
      autoReplyBotGroup: shared.onebot.autoReplyBotGroup,
      quoteGroupReplies: shared.bot.quoteGroupReplies,
      mentionNames: [input.name, input.id],
      commandPrefixes: [`/${input.id}`, input.name]
    }
  };
}

function manifestRow(manifest: AgentManifest): AgentRegistryRow {
  return {
    id: manifest.id,
    name: manifest.name,
    enabled: manifest.enabled,
    workspace: workspaceRelativeReference(path.posix.join(WORKSPACE_LAYOUT.agentRoot, manifest.id)),
    ...(manifest.avatarPath ? { avatarPath: manifest.avatarPath } : {}),
    createdAt: manifest.createdAt,
    updatedAt: manifest.updatedAt
  };
}

function parseManifest(value: unknown, expectedId: string): AgentManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ServiceError(500, "AGENT_MANIFEST_INVALID", "Agent 配置文件无效。");
  }
  const manifest = value as AgentManifest;
  if (manifest.schemaVersion !== 1 || manifest.id !== expectedId || !manifest.name || !manifest.bot || !manifest.onebot) {
    throw new ServiceError(500, "AGENT_MANIFEST_INVALID", "Agent 配置文件无效。");
  }
  const normalized = structuredClone(manifest) as AgentManifest & { persona?: unknown };
  delete normalized.persona;
  return {
    ...normalized,
    bot: {
      ...normalized.bot,
      pokeOnNoReply: normalized.bot.pokeOnNoReply === true,
      quoteGroupReplyExcludedUserIds: normalizeManifestQqList(normalized.bot.quoteGroupReplyExcludedUserIds)
    },
    prompts: {
      overrideSystem: manifest.prompts?.overrideSystem === true
    }
  };
}

function normalizeManifestQqList(value: unknown) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => /^\d{1,32}$/.test(item))
    .slice(0, 100))];
}

function sharedSystemPromptConfig(config: AppConfig): AppConfig {
  return {
    ...structuredClone(config),
    persona: {
      ...structuredClone(config.persona),
      systemPromptWorkspace: workspaceRelativeReference(WORKSPACE_LAYOUT.systemPrompts),
      systemPromptOverride: false
    }
  };
}

async function readOptionalText(filePath: string) {
  if (!filePath) return "";
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

async function writeIfMissing(filePath: string, content: string) {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  try {
    await fs.writeFile(filePath, `${content.trim()}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
}

function normalizeAgentId(value: string) {
  const id = String(value ?? "").trim().toLowerCase();
  if (!AGENT_ID_PATTERN.test(id)) {
    badRequest("AGENT_ID_INVALID", "Agent ID 需要使用 2-32 位小写字母、数字或连字符，并以字母开头。", "id");
  }
  return id;
}

function normalizeAgentName(value: string) {
  const name = String(value ?? "").trim();
  if (!name || name.length > 40) badRequest("AGENT_NAME_INVALID", "Agent 名称需要使用 1-40 个字符。", "name");
  return name;
}

function normalizeAccountLabel(value: string) {
  const label = String(value ?? "").trim();
  if (!label || label.length > 40) badRequest("AGENT_ACCOUNT_LABEL_INVALID", "账号名称需要使用 1-40 个字符。", "label");
  return label;
}

async function writeAvatar(directory: string, input: AgentAvatarInput, fileStem = "avatar") {
  const bytes = decodeBase64(input.dataBase64);
  const extension = avatarExtension(bytes, input.fileName);
  const relativePath = path.posix.join("assets", `${fileStem}.${extension}`);
  await fs.mkdir(path.join(directory, "assets"), { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(directory, relativePath), bytes, { mode: 0o600, flag: "wx" });
  return relativePath;
}

async function removeManagedAvatar(directory: string, avatarPath: string | undefined) {
  if (!avatarPath || !/^assets\/avatar(?:-[A-Za-z0-9_-]+)?\.(?:png|jpg|webp)$/.test(avatarPath)) return;
  const filePath = path.resolve(directory, avatarPath);
  assertInside(directory, filePath);
  await fs.rm(filePath, { force: true });
}

function decodeBase64(value: string) {
  const normalized = String(value ?? "").replace(/^data:[^;]+;base64,/, "").trim();
  if (!normalized || !/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)) {
    badRequest("AGENT_AVATAR_INVALID", "头像数据无效。", "avatar");
  }
  return Buffer.from(normalized, "base64");
}

function avatarExtension(bytes: Buffer, fileName: string) {
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return "jpg";
  if (bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return "webp";
  badRequest("AGENT_AVATAR_INVALID", `不支持的头像格式：${path.extname(fileName) || "未知"}。`, "avatar");
}

function initialPersonaFiles(name: string) {
  return {
    "AGENTS.md": `你是${name}。回复必须是可以直接发送给用户的成品内容。\n`,
    "SOUL.md": `${name}会保持稳定的人格、语气和身份。\n`,
    "PREFERENCE.md": `${name}遵守当前 Agent 的偏好和边界。\n`,
    "DIALOGUE_STYLE_EXAMPLES.md": [
      "# 对话风格示例",
      "",
      "生成回复时必须严格遵从以下示例的语气、句式、节奏、用词和情绪强度。",
      "",
      "用户：你好。",
      `${name}：你好，请告诉我需要处理什么。`,
      ""
    ].join("\n"),
    "USER.md": `${name}根据当前对话和用户画像称呼用户。\n`,
    "RELATION.md": `${name}只使用工作区中明确记录的关系。\n`
  };
}

function initialAgentWorkspaceFiles(config: AppConfig, name: string): Array<readonly [string, string]> {
  const fragments = Object.entries(initialPersonaFiles(name));
  const finalPrompts = PROMPT_FILE_DEFINITIONS.filter((definition) => (
    definition.scope === "persona" && definition.kind === "final"
  )).map((definition) => [
    definition.fileName(config),
    defaultPromptContent(definition.id, name)
  ] as const);
  return [...fragments, ...finalPrompts];
}

async function ensureAccountRuntimeDirectories(accountId: string) {
  const root = getWorkspacePath(WORKSPACE_LAYOUT.napcatAccounts, accountId);
  await Promise.all(["config-full", "qq", "plugins"].map((segment) => (
    fs.mkdir(path.join(root, segment), { recursive: true, mode: 0o700 })
  )));
}

async function migrateLegacyPrimaryAccountRuntime() {
  const target = getWorkspacePath(WORKSPACE_LAYOUT.napcatAccounts, "primary");
  await fs.mkdir(target, { recursive: true, mode: 0o700 });
  const mappings: Array<readonly [string, string]> = [
    [getWorkspacePath(WORKSPACE_LAYOUT.legacyNapcatConfig), path.join(target, "config-full")],
    [getWorkspacePath(WORKSPACE_LAYOUT.legacyNapcatQqState), path.join(target, "qq")],
    [getWorkspacePath(WORKSPACE_LAYOUT.legacyNapcatPlugins), path.join(target, "plugins")],
    [getWorkspacePath(WORKSPACE_LAYOUT.legacyNapcatQrCode), path.join(target, "qrcode.png")],
    [getWorkspacePath(WORKSPACE_LAYOUT.legacyNapcatManualLogin), path.join(target, "manual-login-required")]
  ];
  for (const [source, destination] of mappings) {
    try {
      await fs.cp(source, destination, { recursive: true, errorOnExist: false, force: false });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

async function inferPrimaryAccountQqId() {
  const configDirectory = getWorkspacePath(WORKSPACE_LAYOUT.napcatAccounts, "primary", "config-full");
  try {
    const candidates = new Set((await fs.readdir(configDirectory)).flatMap((fileName) => {
      const match = /^(?:onebot11|napcat)_(\d{5,20})\.json$/.exec(fileName);
      return match?.[1] ? [match[1]] : [];
    }));
    return candidates.size === 1 ? [...candidates][0] : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function atomicWriteJson(filePath: string, value: unknown) {
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await fs.writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  try {
    await fs.rename(temporaryPath, filePath);
  } catch (error) {
    await fs.rm(temporaryPath, { force: true });
    throw error;
  }
}

async function assertPathMissing(filePath: string, code: string, message: string) {
  try {
    await fs.access(filePath);
    conflict(code, message);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function assertInside(root: string, candidate: string) {
  const normalizedRoot = path.resolve(root);
  if (candidate !== normalizedRoot && !candidate.startsWith(`${normalizedRoot}${path.sep}`)) {
    badRequest("AGENT_PATH_INVALID", "Agent 文件路径无效。");
  }
}

function mapSqliteConflict(error: unknown, message = "Agent 已存在。") {
  if (error instanceof ServiceError) return error;
  if (/constraint|unique/i.test(error instanceof Error ? error.message : String(error))) {
    return new ServiceError(409, "AGENT_CONFLICT", message);
  }
  return error;
}

function badRequest(code: string, message: string, field?: string): never {
  throw new ServiceError(400, code, message, field);
}

function notFound(code: string, message: string): never {
  throw new ServiceError(404, code, message);
}

function conflict(code: string, message: string, latestRevision?: string): never {
  throw new ServiceError(409, code, message, undefined, latestRevision);
}
