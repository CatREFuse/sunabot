import crypto from "node:crypto";
import fs from "node:fs/promises";
import { getConfigPath, getWorkspaceDir, loadConfig, saveConfig } from "../config.js";
import { OpenAIProvider } from "../../adapters/model/openaiProvider.js";
import type {
  AgentToolName,
  AppConfig,
  BotConfig,
  BotMemorySettings,
  BotOrchestratorSettings,
  BotToolSettings,
  ProviderConfig
} from "../types.js";
import { AGENT_TOOL_NAMES } from "../types.js";
import { AdminApiError, badRequest, conflict } from "./errors.js";
import { getModelCatalogEntry } from "./models.js";
import {
  DEFAULT_TAVILY_API_KEY_ENV,
  isEnvironmentName,
  looksLikeDirectApiKey,
  resolveTavilyApiKeys
} from "../../adapters/model/webSearchSettings.js";
import {
  adminMutationMutex,
  adminRecoveryState,
  type AdminMutationMutex,
  type AdminRecoveryState
} from "./mutation.js";
import {
  IMAGE_QUALITIES,
  IMAGE_RESOLUTIONS,
  IMAGE_SIZES,
  boolean,
  exactKeys,
  finiteNumber,
  integer,
  object,
  optionalIntegerArray,
  optionalReasoningEffort,
  optionalSecretArray,
  optionalString,
  pathString,
  requiredString,
  stringArray,
  uniqueStrings,
  validateCatalogEffort
} from "./configValidation.js";

export const CONFIG_SECTIONS = [
  "server",
  "persona",
  "providers",
  "bot",
  "memory",
  "orchestrator",
  "tools",
  "bash",
  "onebot"
] as const;

export type ConfigSection = (typeof CONFIG_SECTIONS)[number];
export type ApplyMode = "hot" | "reconnect" | "restart";

const FIXED_PROVIDER_BASE_URLS: Partial<Record<ProviderConfig["kind"], string>> = {
  "codex-responses": "https://chatgpt.com/backend-api/codex",
  "openai-official": "https://api.openai.com",
  "anthropic-official": "https://api.anthropic.com/v1",
  "gemini-official": "https://generativelanguage.googleapis.com/v1beta"
};

export interface ConfigSectionValueMap {
  server: AppConfig["server"];
  persona: Pick<AppConfig["persona"], "agentWorkspace" | "memoryLimit">;
  providers: AppConfig["providers"];
  bot: Pick<BotConfig, "adminQq" | "adminName" | "quoteGroupReplies" | "contextMessageLimit">;
  memory: BotMemorySettings;
  orchestrator: BotOrchestratorSettings;
  tools: BotToolSettings;
  bash: BotConfig["bash"];
  onebot: Omit<AppConfig["onebot"], "quoteGroupReplies">;
}

export interface ConfigEnvelope {
  config: AppConfig;
  revision: string;
  fieldStates: Record<string, {
    applyMode: ApplyMode;
    secretConfigured?: boolean;
    secretCount?: number;
    storedSecretCount?: number;
  }>;
}

export interface PreparedConfigApply {
  verify?(): Promise<void>;
  commit(): void | Promise<void>;
}

export interface ConfigServiceOptions {
  prepareApply: (candidate: AppConfig) => Promise<PreparedConfigApply>;
  mutex?: AdminMutationMutex;
  recoveryState?: AdminRecoveryState;
}

export class ConfigService {
  private readonly mutex: AdminMutationMutex;
  private readonly recoveryState: AdminRecoveryState;

  constructor(private readonly options: ConfigServiceOptions) {
    this.mutex = options.mutex ?? adminMutationMutex;
    this.recoveryState = options.recoveryState ?? adminRecoveryState;
  }

  async readEnvelope(config?: AppConfig): Promise<ConfigEnvelope> {
    const activeConfig = config ?? await loadConfig();
    return {
      config: redactConfigSecrets(activeConfig),
      revision: configRevision(activeConfig),
      fieldStates: configFieldStates(activeConfig)
    };
  }

  getRecoveryStatus() {
    const message = this.recoveryState.get();
    return message ? { required: true, message } : { required: false };
  }

  async patch(sectionInput: string, body: unknown) {
    const section = parseSection(sectionInput);
    const request = parsePatchRequest(body);
    return this.applyMutation(request, (current) => {
      const value = validateSectionValue(section, request.value, current);
      const candidate = mergeSection(current, section, value);
      return {
        candidate,
        applyMode: sectionApplyMode(section, current, candidate),
        restartRequiredFields: restartRequiredFields(section, current, candidate)
      };
    });
  }

  async patchGroupReply(body: unknown) {
    const request = parsePatchRequest(body);
    return this.applyMutation(request, (current) => {
      const value = validateGroupReplyValue(request.value);
      const candidate = structuredClone(current);
      candidate.onebot.autoReplyUserGroup = value.enabled;
      candidate.bot.orchestrator = value.orchestrator;
      return { candidate, applyMode: "hot", restartRequiredFields: [] };
    });
  }

  private async applyMutation(
    request: ReturnType<typeof parsePatchRequest>,
    build: (current: AppConfig) => {
      candidate: AppConfig;
      applyMode: ApplyMode;
      restartRequiredFields: string[];
    }
  ) {
    return this.mutex.runExclusive(async () => {
      const recoveryError = this.recoveryState.get();
      if (recoveryError) {
        throw new AdminApiError(503, "CONFIG_RECOVERY_REQUIRED", recoveryError);
      }

      const current = await loadConfig();
      const currentRevision = configRevision(current);
      if (request.revision !== currentRevision) {
        conflict("CONFIG_REVISION_CONFLICT", "配置已被其他操作修改，请重新载入。", currentRevision);
      }

      const { candidate, applyMode, restartRequiredFields: requiredFields } = build(current);
      validateCompleteConfig(candidate);
      const prepared = await this.options.prepareApply(candidate);

      const latest = await loadConfig();
      const latestRevision = configRevision(latest);
      if (latestRevision !== currentRevision) {
        conflict("CONFIG_REVISION_CONFLICT", "配置文件已在外部修改，请重新载入。", latestRevision);
      }
      await prepared.verify?.();

      const backupPath = `${getConfigPath()}.admin-backup`;
      await writeBackup(backupPath);
      await saveConfig(candidate);
      try {
        await prepared.commit();
      } catch (error) {
        try {
          const rollback = await this.options.prepareApply(current);
          await saveConfig(current);
          await rollback.commit();
        } catch (rollbackError) {
          const message = `配置提交失败且自动恢复失败。备份：${backupPath}。${errorMessage(rollbackError)}`;
          this.recoveryState.requireRecovery(message);
          throw new AdminApiError(503, "CONFIG_RECOVERY_REQUIRED", message);
        }
        throw error;
      }

      await fs.rm(backupPath, { force: true }).catch(() => undefined);
      const envelope = await this.readEnvelope(candidate);
      return {
        ok: true,
        ...envelope,
        applyMode,
        restartRequiredFields: requiredFields
      };
    });
  }
}

export function configRevision(config: AppConfig) {
  return crypto.createHash("sha256").update(stableJson(config), "utf8").digest("hex");
}

function redactConfigSecrets(config: AppConfig) {
  const redacted = structuredClone(config);
  redacted.bot.tools.websearch.tavilyApiKey = "";
  redacted.bot.tools.websearch.tavilyApiKeys = [];
  return redacted;
}

export function stableJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(",")}}`;
}

export function configFieldStates(config: AppConfig): ConfigEnvelope["fieldStates"] {
  const states: ConfigEnvelope["fieldStates"] = {};
  addFieldStates(states, config.server, "server", "restart");
  addFieldStates(states, config.persona, "persona", "hot");
  addFieldStates(states, config.providers, "providers", "hot");
  addFieldStates(states, config.bot, "bot", "hot");
  addFieldStates(states, config.onebot, "onebot", "hot");

  states["onebot.reverseWsPath"] = { applyMode: "restart" };
  states["onebot.accessTokenEnv"] = {
    applyMode: "reconnect",
    secretConfigured: Boolean(process.env[config.onebot.accessTokenEnv])
  };
  const tavilyCredentials = resolveTavilyApiKeys(config.bot.tools.websearch, getWorkspaceDir());
  const storedTavilyKeys = uniqueStrings([
    ...(config.bot.tools.websearch.tavilyApiKeys ?? []),
    config.bot.tools.websearch.tavilyApiKey
  ]);
  states["bot.tools.websearch.tavilyApiKeyEnv"] = {
    applyMode: "hot",
    secretConfigured: tavilyCredentials.length > 0,
    secretCount: tavilyCredentials.length,
    storedSecretCount: storedTavilyKeys.length
  };
  states["bot.tools.websearch.tavilyApiKey"] = states["bot.tools.websearch.tavilyApiKeyEnv"]!;
  states["bot.tools.websearch.tavilyApiKeys"] = states["bot.tools.websearch.tavilyApiKeyEnv"]!;
  states["bot.tools.codex.maxConcurrency"] = { applyMode: "restart" };
  for (const [index, provider] of config.providers.items.entries()) {
    states[`providers.items.${provider.id}`] = { applyMode: "hot" };
    states[`providers.items.${provider.id}.apiKeyEnv`] = {
      applyMode: "hot",
      secretConfigured: new OpenAIProvider(provider).hasApiKey()
    };
    states[`providers.items.${index}.apiKeyEnv`] = states[`providers.items.${provider.id}.apiKeyEnv`]!;
  }
  return states;
}

function addFieldStates(
  states: ConfigEnvelope["fieldStates"],
  value: unknown,
  prefix: string,
  applyMode: ApplyMode
) {
  states[prefix] = { applyMode };
  if (Array.isArray(value)) {
    value.forEach((item, index) => addFieldStates(states, item, `${prefix}.${index}`, applyMode));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    addFieldStates(states, child, `${prefix}.${key}`, applyMode);
  }
}

export function validateProviderDraft(input: unknown): ProviderConfig {
  return validateProvider(input, "provider");
}

function parseSection(value: string): ConfigSection {
  if (!(CONFIG_SECTIONS as readonly string[]).includes(value)) {
    throw new AdminApiError(404, "CONFIG_SECTION_NOT_FOUND", "配置分区不存在。");
  }
  return value as ConfigSection;
}

function parsePatchRequest(input: unknown) {
  const body = object(input, "request");
  exactKeys(body, ["revision", "value"], "request");
  const revision = requiredString(body.revision, "revision", { trim: true, min: 1, max: 128 });
  return { revision, value: body.value };
}

function validateGroupReplyValue(input: unknown) {
  const value = object(input, "groupReply");
  exactKeys(value, ["enabled", "orchestrator"], "groupReply");
  return {
    enabled: boolean(value.enabled, "groupReply.enabled"),
    orchestrator: validateOrchestrator(value.orchestrator)
  };
}

function validateSectionValue<S extends ConfigSection>(
  section: S,
  value: unknown,
  current?: AppConfig
): ConfigSectionValueMap[S] {
  switch (section) {
    case "server": return validateServer(value) as ConfigSectionValueMap[S];
    case "persona": return validatePersona(value) as ConfigSectionValueMap[S];
    case "providers": return validateProviders(value, current?.providers) as ConfigSectionValueMap[S];
    case "bot": return validateBot(value) as ConfigSectionValueMap[S];
    case "memory": return validateMemory(value) as ConfigSectionValueMap[S];
    case "orchestrator": return validateOrchestrator(value) as ConfigSectionValueMap[S];
    case "tools": return validateTools(value, current?.bot.tools) as ConfigSectionValueMap[S];
    case "bash": return validateBash(value) as ConfigSectionValueMap[S];
    case "onebot": return validateOnebot(value) as ConfigSectionValueMap[S];
  }
}

function validateServer(input: unknown): AppConfig["server"] {
  const value = object(input, "server");
  exactKeys(value, ["host", "port"], "server");
  return {
    host: requiredString(value.host, "server.host", { trim: true, min: 1, max: 255 }),
    port: integer(value.port, "server.port", 1, 65_535)
  };
}

function validatePersona(input: unknown): ConfigSectionValueMap["persona"] {
  const value = object(input, "persona");
  exactKeys(value, ["agentWorkspace", "memoryLimit"], "persona");
  return {
    agentWorkspace: pathString(value.agentWorkspace, "persona.agentWorkspace", false),
    memoryLimit: integer(value.memoryLimit, "persona.memoryLimit", 1, 10_000)
  };
}

function validateProviders(input: unknown, current?: AppConfig["providers"]): AppConfig["providers"] {
  const value = object(input, "providers");
  exactKeys(value, ["defaultProviderId", "items"], "providers");
  const defaultProviderId = requiredString(value.defaultProviderId, "providers.defaultProviderId", { trim: true, min: 1, max: 64 });
  if (!Array.isArray(value.items) || value.items.length === 0) {
    badRequest("CONFIG_INVALID", "至少需要保留一个 Provider。", "providers.items");
  }
  if (value.items.length > 64) badRequest("CONFIG_INVALID", "Provider 数量不能超过 64。", "providers.items");
  const items = value.items.map((item, index) => validateProvider(item, `providers.items.${index}`));
  for (const item of items) {
    const previous = current?.items.find((candidate) => candidate.id === item.id);
    if (previous && previous.kind !== item.kind) {
      badRequest("CONFIG_INVALID", "Provider 类型在创建后不能修改。", `providers.items.${item.id}.kind`);
    }
  }
  const ids = new Set<string>();
  for (const provider of items) {
    if (ids.has(provider.id)) badRequest("CONFIG_INVALID", "Provider ID 不能重复。", "providers.items");
    ids.add(provider.id);
  }
  const defaultProvider = items.find((provider) => provider.id === defaultProviderId);
  if (!defaultProvider) badRequest("CONFIG_INVALID", "默认 Provider 不存在。", "providers.defaultProviderId");
  if (!defaultProvider.enabled) badRequest("CONFIG_INVALID", "默认 Provider 必须启用。", "providers.defaultProviderId");
  return { defaultProviderId, items };
}

function validateProvider(input: unknown, field: string): ProviderConfig {
  const value = object(input, field);
  exactKeys(value, [
    "id", "label", "kind", "enabled", "model", "imageModel", "baseUrl", "apiKeyEnv", "envFile",
    "temperature", "maxOutputTokens", "reasoningEffort", "modelSource", "multimodal",
    "detectedMultimodal", "visionProviderId", "visionModel"
  ], field);
  const id = requiredString(value.id, `${field}.id`, { trim: true, min: 1, max: 64 });
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) {
    badRequest("CONFIG_INVALID", "Provider ID 只能包含字母、数字、点、下划线和连字符。", `${field}.id`);
  }
  const kindValue = String(value.kind);
  if (!["codex-responses", "openai-official", "anthropic-official", "openai-compatible", "anthropic-compatible", "gemini-official", "gemini-compatible"].includes(kindValue)) {
    badRequest("CONFIG_INVALID", "Provider 协议无效。", `${field}.kind`);
  }
  const kind = kindValue as ProviderConfig["kind"];
  const model = requiredString(value.model, `${field}.model`, { trim: true, min: 1, max: 200 });
  const reasoningEffort = optionalReasoningEffort(value.reasoningEffort, `${field}.reasoningEffort`);
  validateCatalogEffort(model, reasoningEffort, `${field}.reasoningEffort`);
  const requestedBaseUrl = optionalString(value.baseUrl, `${field}.baseUrl`, 2_048);
  if (requestedBaseUrl) {
    try {
      const url = new URL(requestedBaseUrl);
      if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("protocol");
      if (url.username || url.password) throw new Error("credentials");
    } catch {
      badRequest("CONFIG_INVALID", "Base URL 必须是不含凭据的 HTTP 或 HTTPS 地址。", `${field}.baseUrl`);
    }
  }
  const fixedBaseUrl = FIXED_PROVIDER_BASE_URLS[kind];
  if (fixedBaseUrl && requestedBaseUrl?.replace(/\/+$/, "") !== fixedBaseUrl) {
    badRequest("CONFIG_INVALID", "官方 Provider 地址不能修改。", `${field}.baseUrl`);
  }
  const baseUrl = fixedBaseUrl ?? requestedBaseUrl;
  const apiKeyEnv = requiredString(value.apiKeyEnv, `${field}.apiKeyEnv`, { trim: true, min: 1, max: 128 });
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(apiKeyEnv)) {
    badRequest("CONFIG_INVALID", "API Key 环境变量名称无效。", `${field}.apiKeyEnv`);
  }
  const modelSource = value.modelSource == null
    ? (kind.endsWith("-compatible") ? "custom" : "remote")
    : value.modelSource === "remote" || value.modelSource === "custom"
      ? value.modelSource
      : undefined;
  if (!modelSource) badRequest("CONFIG_INVALID", "模型 ID 来源无效。", `${field}.modelSource`);
  const multimodal = value.multimodal == null
    ? "auto"
    : value.multimodal === "auto" || value.multimodal === "enabled" || value.multimodal === "disabled"
      ? value.multimodal
      : undefined;
  if (!multimodal) badRequest("CONFIG_INVALID", "多模态设置无效。", `${field}.multimodal`);
  const detectedMultimodal = value.detectedMultimodal == null
    ? undefined
    : boolean(value.detectedMultimodal, `${field}.detectedMultimodal`);
  const visionProviderId = optionalString(value.visionProviderId, `${field}.visionProviderId`, 64);
  const visionModel = optionalString(value.visionModel, `${field}.visionModel`, 200);
  return {
    id,
    label: requiredString(value.label, `${field}.label`, { trim: true, min: 1, max: 120 }),
    kind,
    enabled: boolean(value.enabled, `${field}.enabled`),
    model,
    imageModel: requiredString(value.imageModel, `${field}.imageModel`, { trim: true, min: 1, max: 200 }),
    ...(baseUrl ? { baseUrl } : {}),
    apiKeyEnv,
    ...(value.envFile == null || value.envFile === "" ? {} : { envFile: pathString(value.envFile, `${field}.envFile`, false) }),
    temperature: finiteNumber(value.temperature, `${field}.temperature`, 0, 2),
    maxOutputTokens: integer(value.maxOutputTokens, `${field}.maxOutputTokens`, 1, 1_000_000),
    ...(reasoningEffort ? { reasoningEffort } : {}),
    modelSource,
    multimodal,
    ...(detectedMultimodal == null ? {} : { detectedMultimodal }),
    ...(visionProviderId ? { visionProviderId } : {}),
    ...(visionModel ? { visionModel } : {})
  };
}

function validateBot(input: unknown): ConfigSectionValueMap["bot"] {
  const value = object(input, "bot");
  exactKeys(value, ["adminQq", "adminName", "quoteGroupReplies", "contextMessageLimit"], "bot");
  const adminQq = requiredString(value.adminQq, "bot.adminQq", { trim: true, min: 0, max: 32, allowEmpty: true });
  if (adminQq && !/^\d+$/.test(adminQq)) badRequest("CONFIG_INVALID", "管理员 QQ 必须是数字。", "bot.adminQq");
  return {
    adminQq,
    adminName: requiredString(value.adminName, "bot.adminName", { trim: true, min: 1, max: 80 }),
    quoteGroupReplies: boolean(value.quoteGroupReplies, "bot.quoteGroupReplies"),
    contextMessageLimit: integer(value.contextMessageLimit, "bot.contextMessageLimit", 1, 120)
  };
}

function validateMemory(input: unknown): BotMemorySettings {
  const value = object(input, "memory");
  exactKeys(value, [
    "memoryModel", "reasoningEffort", "messageThreshold", "workingMemoryMaxEntries",
    "workMemoryCompressInPrompt", "workMemoryCompressOutPrompt", "userProfilePrompt"
  ], "memory");
  const memoryModel = requiredString(value.memoryModel, "memory.memoryModel", { trim: true, min: 1, max: 200 });
  const reasoningEffort = optionalReasoningEffort(value.reasoningEffort, "memory.reasoningEffort");
  validateCatalogEffort(memoryModel, reasoningEffort, "memory.reasoningEffort");
  return {
    memoryModel,
    ...(reasoningEffort ? { reasoningEffort } : {}),
    messageThreshold: integer(value.messageThreshold, "memory.messageThreshold", 1, 200),
    workingMemoryMaxEntries: integer(value.workingMemoryMaxEntries, "memory.workingMemoryMaxEntries", 1, 1_000),
    workMemoryCompressInPrompt: pathString(value.workMemoryCompressInPrompt, "memory.workMemoryCompressInPrompt", true),
    workMemoryCompressOutPrompt: pathString(value.workMemoryCompressOutPrompt, "memory.workMemoryCompressOutPrompt", true),
    userProfilePrompt: pathString(value.userProfilePrompt, "memory.userProfilePrompt", true)
  };
}

function validateOrchestrator(input: unknown): BotOrchestratorSettings {
  const value = object(input, "orchestrator");
  exactKeys(value, [
    "enabled", "userGroupchatOrchestratorModel", "reasoningEffort", "promptFile", "messageThreshold", "recentMessageWindowMs"
  ], "orchestrator");
  const model = requiredString(value.userGroupchatOrchestratorModel, "orchestrator.userGroupchatOrchestratorModel", {
    trim: true,
    min: 1,
    max: 200
  });
  const reasoningEffort = optionalReasoningEffort(value.reasoningEffort, "orchestrator.reasoningEffort");
  validateCatalogEffort(model, reasoningEffort, "orchestrator.reasoningEffort");
  return {
    enabled: boolean(value.enabled, "orchestrator.enabled"),
    userGroupchatOrchestratorModel: model,
    ...(reasoningEffort ? { reasoningEffort } : {}),
    promptFile: pathString(value.promptFile, "orchestrator.promptFile", true),
    messageThreshold: integer(value.messageThreshold, "orchestrator.messageThreshold", 0, 200),
    recentMessageWindowMs: integer(value.recentMessageWindowMs, "orchestrator.recentMessageWindowMs", 1_000, 3_600_000)
  };
}

function validateTools(input: unknown, current?: BotToolSettings): BotToolSettings {
  const value = object(input, "tools");
  exactKeys(value, ["maxCalls", "overrides", "websearch", "codex", "generateImg"], "tools");
  const websearch = object(value.websearch, "tools.websearch");
  exactKeys(websearch, [
    "provider", "tavilyApiKey", "tavilyApiKeys", "tavilyApiKeyEnv",
    "clearTavilyApiKey", "removeTavilyApiKeyIndexes", "maxResults"
  ], "tools.websearch");
  if (websearch.provider !== "tavily") {
    badRequest("CONFIG_INVALID", "网页搜索 Provider 无效。", "tools.websearch.provider");
  }
  let tavilyApiKey = requiredString(websearch.tavilyApiKey, "tools.websearch.tavilyApiKey", {
    trim: true,
    min: 0,
    max: 512,
    allowEmpty: true
  });
  let tavilyApiKeyEnv = requiredString(websearch.tavilyApiKeyEnv, "tools.websearch.tavilyApiKeyEnv", {
    trim: true,
    min: 1,
    max: 512
  });
  const clearTavilyApiKey = websearch.clearTavilyApiKey == null
    ? false
    : boolean(websearch.clearTavilyApiKey, "tools.websearch.clearTavilyApiKey");
  const currentTavilyApiKeys = uniqueStrings([
    ...(current?.websearch.tavilyApiKeys ?? []),
    current?.websearch.tavilyApiKey ?? ""
  ]);
  const removeTavilyApiKeyIndexes = optionalIntegerArray(
    websearch.removeTavilyApiKeyIndexes,
    "tools.websearch.removeTavilyApiKeyIndexes",
    currentTavilyApiKeys.length
  );
  const newTavilyApiKeys = optionalSecretArray(websearch.tavilyApiKeys, "tools.websearch.tavilyApiKeys");
  if (!isEnvironmentName(tavilyApiKeyEnv)) {
    if (!tavilyApiKey && looksLikeDirectApiKey(tavilyApiKeyEnv)) {
      tavilyApiKey = tavilyApiKeyEnv;
      tavilyApiKeyEnv = DEFAULT_TAVILY_API_KEY_ENV;
    } else {
      badRequest(
        "CONFIG_INVALID",
        "请输入环境变量名；API Key 请填写到 Tavily API Key。",
        "tools.websearch.tavilyApiKeyEnv"
      );
    }
  }
  const retainedTavilyApiKeys = clearTavilyApiKey
    ? []
    : currentTavilyApiKeys.filter((_, index) => !removeTavilyApiKeyIndexes.includes(index));
  const tavilyApiKeys = uniqueStrings([...retainedTavilyApiKeys, ...newTavilyApiKeys, tavilyApiKey]);
  const codex = object(value.codex, "tools.codex");
  exactKeys(codex, ["enabled", "model", "codexExecutable", "timeoutMs", "maxConcurrency"], "tools.codex");
  const codexModel = requiredString(codex.model, "tools.codex.model", {
    trim: true,
    min: 1,
    max: 200
  });
  if (!getModelCatalogEntry(codexModel)) {
    badRequest("CONFIG_INVALID", "Codex 模型无效。", "tools.codex.model");
  }
  const generateImg = object(value.generateImg, "tools.generateImg");
  exactKeys(generateImg, ["provider", "size", "resolution", "quality"], "tools.generateImg");
  if (generateImg.provider !== "codex-image-gen" && generateImg.provider !== "custom") {
    badRequest("CONFIG_INVALID", "图像生成 Provider 无效。", "tools.generateImg.provider");
  }
  if (!IMAGE_SIZES.includes(String(generateImg.size))) badRequest("CONFIG_INVALID", "图像尺寸无效。", "tools.generateImg.size");
  if (!IMAGE_RESOLUTIONS.includes(String(generateImg.resolution))) {
    badRequest("CONFIG_INVALID", "图像清晰度无效。", "tools.generateImg.resolution");
  }
  if (!IMAGE_QUALITIES.includes(String(generateImg.quality))) {
    badRequest("CONFIG_INVALID", "图像质量无效。", "tools.generateImg.quality");
  }
  return {
    maxCalls: value.maxCalls == null ? current?.maxCalls ?? 20 : integer(value.maxCalls, "tools.maxCalls", 1, 100),
    overrides: value.overrides == null
      ? structuredClone(current?.overrides ?? {})
      : validateToolOverrides(value.overrides),
    websearch: {
      provider: "tavily",
      tavilyApiKey: "",
      tavilyApiKeys,
      tavilyApiKeyEnv,
      maxResults: integer(websearch.maxResults, "tools.websearch.maxResults", 1, 10)
    },
    codex: {
      enabled: boolean(codex.enabled, "tools.codex.enabled"),
      model: codexModel,
      codexExecutable: requiredString(codex.codexExecutable, "tools.codex.codexExecutable", {
        trim: true,
        min: 1,
        max: 2_048
      }),
      timeoutMs: integer(codex.timeoutMs, "tools.codex.timeoutMs", 1_000, 86_400_000),
      maxConcurrency: integer(codex.maxConcurrency, "tools.codex.maxConcurrency", 1, 16)
    },
    generateImg: {
      provider: generateImg.provider,
      size: generateImg.size as BotToolSettings["generateImg"]["size"],
      resolution: generateImg.resolution as BotToolSettings["generateImg"]["resolution"],
      quality: generateImg.quality as BotToolSettings["generateImg"]["quality"]
    }
  };
}

function validateToolOverrides(input: unknown): NonNullable<BotToolSettings["overrides"]> {
  if (input == null) return {};
  const value = object(input, "tools.overrides");
  const overrides: NonNullable<BotToolSettings["overrides"]> = {};
  for (const [name, rawOverride] of Object.entries(value)) {
    if (!(AGENT_TOOL_NAMES as readonly string[]).includes(name)) {
      badRequest("CONFIG_UNKNOWN_FIELD", "包含不支持的工具。", `tools.overrides.${name}`);
    }
    const field = `tools.overrides.${name}`;
    const override = object(rawOverride, field);
    const extra = Object.keys(override).find((key) => key !== "enabled" && key !== "description");
    if (extra) badRequest("CONFIG_UNKNOWN_FIELD", "包含不支持的字段。", `${field}.${extra}`);
    const enabled = override.enabled == null ? undefined : boolean(override.enabled, `${field}.enabled`);
    let description: string | undefined;
    if (override.description != null && override.description !== "") {
      description = requiredString(override.description, `${field}.description`, {
        trim: true,
        min: 1,
        max: 4_000
      });
    }
    if (enabled == null && description == null) continue;
    overrides[name as AgentToolName] = {
      ...(enabled == null ? {} : { enabled }),
      ...(description == null ? {} : { description })
    };
  }
  return overrides;
}

function validateBash(input: unknown): BotConfig["bash"] {
  const value = object(input, "bash");
  exactKeys(value, ["enabled", "allowGroup", "adminOnly", "workspaceOnly", "blockedKeywords"], "bash");
  return {
    enabled: boolean(value.enabled, "bash.enabled"),
    allowGroup: boolean(value.allowGroup, "bash.allowGroup"),
    adminOnly: boolean(value.adminOnly, "bash.adminOnly"),
    workspaceOnly: boolean(value.workspaceOnly, "bash.workspaceOnly"),
    blockedKeywords: stringArray(value.blockedKeywords, "bash.blockedKeywords", 100, 200)
  };
}

function validateOnebot(input: unknown): ConfigSectionValueMap["onebot"] {
  const value = object(input, "onebot");
  exactKeys(value, [
    "reverseWsPath", "accessTokenEnv", "autoReplyPrivate", "autoReplyUserGroup", "autoReplyBotGroup",
    "mentionNames", "commandPrefixes"
  ], "onebot");
  const reverseWsPath = requiredString(value.reverseWsPath, "onebot.reverseWsPath", { trim: true, min: 1, max: 256 });
  if (!reverseWsPath.startsWith("/") || reverseWsPath.includes("?") || reverseWsPath.includes("#")) {
    badRequest("CONFIG_INVALID", "OneBot WebSocket 路径必须以 / 开头且不能包含查询参数。", "onebot.reverseWsPath");
  }
  const accessTokenEnv = requiredString(value.accessTokenEnv, "onebot.accessTokenEnv", { trim: true, min: 1, max: 128 });
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(accessTokenEnv)) {
    badRequest("CONFIG_INVALID", "OneBot Token 环境变量名称无效。", "onebot.accessTokenEnv");
  }
  return {
    reverseWsPath,
    accessTokenEnv,
    autoReplyPrivate: boolean(value.autoReplyPrivate, "onebot.autoReplyPrivate"),
    autoReplyUserGroup: boolean(value.autoReplyUserGroup, "onebot.autoReplyUserGroup"),
    autoReplyBotGroup: boolean(value.autoReplyBotGroup, "onebot.autoReplyBotGroup"),
    mentionNames: stringArray(value.mentionNames, "onebot.mentionNames", 100, 100),
    commandPrefixes: stringArray(value.commandPrefixes, "onebot.commandPrefixes", 100, 100)
  };
}

function validateCompleteConfig(config: AppConfig) {
  if (config.persona.defaultAgentId !== "plana") {
    badRequest("CONFIG_INVALID", "defaultAgentId 必须为 plana。", "persona.defaultAgentId");
  }
  validateServer(config.server);
  validatePersona({
    agentWorkspace: config.persona.agentWorkspace,
    memoryLimit: config.persona.memoryLimit
  });
  validateProviders(config.providers);
  validateBot({
    adminQq: config.bot.adminQq,
    adminName: config.bot.adminName,
    quoteGroupReplies: config.bot.quoteGroupReplies,
    contextMessageLimit: config.bot.contextMessageLimit
  });
  validateMemory(config.bot.memory);
  validateOrchestrator(config.bot.orchestrator);
  validateTools(config.bot.tools);
  validateBash(config.bot.bash);
  const { quoteGroupReplies: _mirror, ...onebot } = config.onebot;
  validateOnebot(onebot);
  if (config.onebot.quoteGroupReplies !== config.bot.quoteGroupReplies) {
    badRequest("CONFIG_INVALID", "引用回复镜像字段不一致。", "onebot.quoteGroupReplies");
  }
}

function mergeSection<S extends ConfigSection>(
  current: AppConfig,
  section: S,
  value: ConfigSectionValueMap[S]
): AppConfig {
  const candidate = structuredClone(current);
  switch (section) {
    case "server": candidate.server = value as ConfigSectionValueMap["server"]; break;
    case "persona": candidate.persona = { ...candidate.persona, ...(value as ConfigSectionValueMap["persona"]) }; break;
    case "providers": candidate.providers = value as ConfigSectionValueMap["providers"]; break;
    case "bot": {
      candidate.bot = { ...candidate.bot, ...(value as ConfigSectionValueMap["bot"]) };
      candidate.onebot.quoteGroupReplies = candidate.bot.quoteGroupReplies;
      break;
    }
    case "memory": candidate.bot.memory = value as ConfigSectionValueMap["memory"]; break;
    case "orchestrator": candidate.bot.orchestrator = value as ConfigSectionValueMap["orchestrator"]; break;
    case "tools": candidate.bot.tools = value as ConfigSectionValueMap["tools"]; break;
    case "bash": candidate.bot.bash = value as ConfigSectionValueMap["bash"]; break;
    case "onebot": candidate.onebot = {
      ...(value as ConfigSectionValueMap["onebot"]),
      quoteGroupReplies: candidate.bot.quoteGroupReplies
    }; break;
  }
  return candidate;
}

function sectionApplyMode(section: ConfigSection, before: AppConfig, after: AppConfig): ApplyMode {
  if (section === "server") return "restart";
  if (
    section === "tools" &&
    before.bot.tools.codex.maxConcurrency !== after.bot.tools.codex.maxConcurrency
  ) return "restart";
  if (section === "onebot" && before.onebot.reverseWsPath !== after.onebot.reverseWsPath) return "restart";
  if (section === "onebot" && before.onebot.accessTokenEnv !== after.onebot.accessTokenEnv) return "reconnect";
  return "hot";
}

function restartRequiredFields(section: ConfigSection, before: AppConfig, after: AppConfig) {
  const fields: string[] = [];
  if (section === "server" && before.server.host !== after.server.host) fields.push("server.host");
  if (section === "server" && before.server.port !== after.server.port) fields.push("server.port");
  if (section === "onebot" && before.onebot.reverseWsPath !== after.onebot.reverseWsPath) {
    fields.push("onebot.reverseWsPath");
  }
  if (
    section === "tools" &&
    before.bot.tools.codex.maxConcurrency !== after.bot.tools.codex.maxConcurrency
  ) {
    fields.push("tools.codex.maxConcurrency");
  }
  return fields;
}

async function writeBackup(backupPath: string) {
  try {
    await fs.copyFile(getConfigPath(), backupPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
