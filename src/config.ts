import fs from "node:fs/promises";
import path from "node:path";
import dotenv from "dotenv";
import {
  AGENT_TOOL_NAMES,
  AppConfig,
  BotConfig,
  BotDirectorSettings,
  BotImageReaderSettings,
  BotMemorySettings,
  BotOrchestratorSettings,
  BotToneSettings,
  BotToolOverride,
  BotToolSettings,
  BroadcastStormConfig,
  ProviderConfig,
  ReasoningEffort,
  DEFAULT_REPLY_DEBOUNCE_MS,
  MIN_REPLY_DEBOUNCE_MS,
  MAX_REPLY_DEBOUNCE_MS
} from "./types.js";
import { isReasoningEffort, resolveModelReasoningEffort } from "../packages/contracts/admin/models.js";
import {
  DEFAULT_TAVILY_API_KEY_ENV,
  normalizeTavilySettings
} from "../adapters/model/webSearchSettings.js";
import {
  LEGACY_WORKSPACE_LAYOUT,
  WORKSPACE_LAYOUT,
  workspaceRelativeReference
} from "../packages/platform/workspaceLayout.js";
import {
  getRootDir,
  getWorkspaceDir,
  getWorkspacePath,
  resolveProjectPath
} from "../packages/platform/projectPaths.js";

const AUTO_CODEX_EXECUTABLE = "auto";
export const CONFIG_SCHEMA_VERSION = 1 as const;

if (process.env.NODE_ENV !== "test") {
  dotenv.config({ path: getWorkspacePath(WORKSPACE_LAYOUT.secretsEnv), override: false });
}

export { getRootDir, getWorkspaceDir, getWorkspacePath, resolveProjectPath };

export function getConfigPath() {
  return process.env.SUNABOT_CONFIG ?? getWorkspacePath(WORKSPACE_LAYOUT.config);
}

export function defaultConfig(): AppConfig {
  const host = process.env.SUNABOT_HOST?.trim() || "127.0.0.1";
  const port = runtimePort(process.env.SUNABOT_PORT);
  const runtimeEnvReference = workspaceRelativeReference(WORKSPACE_LAYOUT.secretsEnv);

  const providers: ProviderConfig[] = [
    {
      id: "open-arona-codex",
      label: "Codex 订阅",
      kind: "codex-responses",
      enabled: true,
      model: "gpt-5.5",
      imageModel: "gpt-image-2",
      baseUrl: "https://chatgpt.com/backend-api/codex",
      apiKeyEnv: "CODEX_ACCESS_TOKEN",
      envFile: runtimeEnvReference,
      temperature: 0.7,
      maxOutputTokens: 2400,
      reasoningEffort: "medium",
      modelSource: "remote",
      multimodal: "auto"
    },
    {
      id: "openai-api",
      label: "OpenAI API",
      kind: "openai-official",
      enabled: true,
      model: "gpt-5.5",
      imageModel: "gpt-image-2",
      baseUrl: "https://api.openai.com",
      apiKeyEnv: "OPENAI_API_KEY",
      envFile: runtimeEnvReference,
      temperature: 0.7,
      maxOutputTokens: 2400,
      reasoningEffort: "medium",
      modelSource: "remote",
      multimodal: "auto"
    }
  ];

  return {
    schemaVersion: CONFIG_SCHEMA_VERSION,
    server: { host, port },
    persona: {
      defaultAgentId: "plana",
      name: "普拉娜",
      agentWorkspace: workspaceRelativeReference(WORKSPACE_LAYOUT.defaultAgent),
      systemPromptWorkspace: workspaceRelativeReference(WORKSPACE_LAYOUT.systemPrompts),
      systemPromptOverride: false
    },
    providers: {
      defaultProviderId: providers[0]?.id ?? "open-arona-codex",
      items: providers
    },
    broadcastStorm: {
      enabled: true,
      windowMinutes: 2,
      replyThreshold: 3,
      cooldownMinutes: 1,
      additionalQqIds: []
    },
    normalReply: {
      maxRetries: 3
    },
    bot: {
      adminQq: "",
      adminName: "猫老师",
      replyModel: providers[0]?.model ?? "gpt-5.5",
      replyReasoningEffort: "medium",
      imageReader: {
        enabled: true,
        providerId: providers[0]?.id ?? "",
        model: providers[0]?.model ?? "gpt-5.5",
        reasoningEffort: "low"
      },
      replyDebounceMs: DEFAULT_REPLY_DEBOUNCE_MS,
      pokeOnNoReply: false,
      quoteGroupReplies: true,
      quoteGroupReplyExcludedUserIds: [],
      contextMessageLimit: 48,
      emojiSendSize: 512,
      emojiSendSeparately: false,
      tone: {
        enabled: false,
        segmentedReply: false,
        followMainModel: false,
        providerId: "",
        model: "gpt-5.4-mini",
        reasoningEffort: "low",
        temperature: 0.7,
        maxOutputTokens: 2400,
        maxRetries: 2
      },
      director: {
        enabled: false
      },
      memory: {
        memoryModel: "gpt-5.4-mini",
        reasoningEffort: "low",
        messageThreshold: 48,
        workingMemoryMaxEntries: 100,
        dreamRecentWindowHours: 48,
        dreamRecentMemoryLimit: 12,
        dreamOlderMemoryLimit: 12,
        workMemoryCompressInPrompt: "work_memory_compress_in.json",
        workMemoryCompressOutPrompt: "work_memory_compress_out.json",
        userProfilePrompt: "user_profile_prompt.json"
      },
      orchestrator: {
        enabled: false,
        userGroupchatOrchestratorModel: "gpt-5.4-mini",
        groupThreadModel: "gpt-5.4-mini",
        reasoningEffort: "medium",
        promptFile: "user_groupchat_orchestrator.json",
        messageThreshold: 10,
        recentMessageWindowMs: 60_000
      },
      tools: {
        maxCalls: 20,
        overrides: {},
        websearch: {
          provider: "tavily",
          tavilyApiKey: "",
          tavilyApiKeys: [],
          tavilyApiKeyEnv: DEFAULT_TAVILY_API_KEY_ENV,
          maxResults: 5
        },
        codex: {
          enabled: true,
          model: "gpt-5.4-mini",
          codexExecutable: AUTO_CODEX_EXECUTABLE,
          timeoutMs: 900_000,
          maxConcurrency: 2
        },
        generateImg: {
          provider: "codex-image-gen",
          size: "1024x1024",
          resolution: "1K",
          quality: "high"
        }
      },
      bash: {
        enabled: false,
        adminPrivateBackend: "docker",
        auditModel: "gpt-5.4-mini",
        strictMode: true,
        allowGroup: false,
        adminOnly: true,
        workspaceOnly: true,
        blockedKeywords: ["rm"]
      }
    },
    onebot: {
      reverseWsPath: "/onebot/v11/ws",
      accessTokenEnv: "ONEBOT_ACCESS_TOKEN",
      autoReplyPrivate: true,
      autoReplyUserGroup: true,
      autoReplyBotGroup: false,
      quoteGroupReplies: true,
      mentionNames: ["普拉娜", "Plana", "plana", "suna", "sunabot"],
      commandPrefixes: ["/suna", "/sunabot", "普拉娜"]
    }
  };
}

export async function ensureWorkspace() {
  await assertWorkspaceLayoutReady();
  const configPath = getConfigPath();
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await Promise.all([
    WORKSPACE_LAYOUT.defaultAgent,
    WORKSPACE_LAYOUT.mediaImages,
    path.dirname(WORKSPACE_LAYOUT.database),
    WORKSPACE_LAYOUT.attachmentCache,
    WORKSPACE_LAYOUT.runtimeLogs,
    WORKSPACE_LAYOUT.runtimeTemporary,
    WORKSPACE_LAYOUT.napcatAccounts,
    path.dirname(WORKSPACE_LAYOUT.secretsEnv),
    WORKSPACE_LAYOUT.backups
  ].map((relativePath) => fs.mkdir(getWorkspacePath(relativePath), { recursive: true, mode: 0o700 })));
}

export async function loadConfig(): Promise<AppConfig> {
  await ensureWorkspace();
  const configPath = getConfigPath();

  try {
    const raw = await fs.readFile(configPath, "utf8");
    return normalizeConfigDocument(JSON.parse(raw));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
    const config = defaultConfig();
    await saveConfig(config);
    return config;
  }
}

export async function saveConfig(config: AppConfig) {
  await ensureWorkspace();
  const configPath = getConfigPath();
  const temporaryPath = path.join(
    path.dirname(configPath),
    `.${path.basename(configPath)}.${process.pid}.${Date.now()}.tmp`
  );
  try {
    const handle = await fs.open(temporaryPath, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8" });
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temporaryPath, configPath);
    await syncDirectory(path.dirname(configPath));
  } catch (error) {
    await fs.rm(temporaryPath, { force: true });
    throw error;
  }
}

async function syncDirectory(directory: string) {
  let handle;
  try {
    handle = await fs.open(directory, "r");
    await handle.sync();
  } catch {
    // Directory fsync is unavailable on some supported filesystems; the file itself is already synced.
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export function getAgentSessionQueuePath(config: Pick<AppConfig, "persona">) {
  if (config.persona.defaultAgentId === "plana") return getWorkspacePath(WORKSPACE_LAYOUT.sessionQueue);
  const agentWorkspace = resolveProjectPath(config.persona.agentWorkspace);
  if (!agentWorkspace) throw new Error(`Agent workspace is invalid: ${config.persona.agentWorkspace}`);
  return path.join(agentWorkspace, "data", "session-queue.sqlite");
}

export function getAgentPrivatePath(config: Pick<AppConfig, "persona">, globalPath: string, ...segments: string[]) {
  if (config.persona.defaultAgentId === "plana") return getWorkspacePath(globalPath, ...segments);
  const agentWorkspace = resolveProjectPath(config.persona.agentWorkspace);
  if (!agentWorkspace) throw new Error(`Agent workspace is invalid: ${config.persona.agentWorkspace}`);
  return path.join(agentWorkspace, ...segments);
}

async function assertWorkspaceLayoutReady() {
  if (process.env.SUNABOT_CONFIG?.trim()) return;
  const currentConfig = getWorkspacePath(WORKSPACE_LAYOUT.config);
  try {
    await fs.access(currentConfig);
    return;
  } catch {
    // A fresh workspace is valid. A legacy workspace must be migrated while the service is stopped.
  }

  const legacyMarkers = [
    LEGACY_WORKSPACE_LAYOUT.config,
    LEGACY_WORKSPACE_LAYOUT.agentRoot,
    LEGACY_WORKSPACE_LAYOUT.database,
    LEGACY_WORKSPACE_LAYOUT.sessionQueue,
    LEGACY_WORKSPACE_LAYOUT.secretsEnv,
    LEGACY_WORKSPACE_LAYOUT.security,
    LEGACY_WORKSPACE_LAYOUT.napcatState
  ];
  for (const relativePath of legacyMarkers) {
    try {
      await fs.access(getWorkspacePath(relativePath));
      const error = new Error("检测到旧 workspace 布局；请停止服务后运行 npm run workspace:migrate。");
      Object.assign(error, { code: "WORKSPACE_LAYOUT_MIGRATION_REQUIRED" });
      throw error;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "WORKSPACE_LAYOUT_MIGRATION_REQUIRED") throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

export function getDefaultProvider(config: AppConfig) {
  return (
    config.providers.items.find((provider) => provider.id === config.providers.defaultProviderId) ??
    config.providers.items.find((provider) => provider.enabled) ??
    config.providers.items[0]
  );
}

export function normalizeConfigDocument(
  input: unknown,
  options: { applyRuntimeOverrides?: boolean } = {}
): AppConfig {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("系统配置必须是 JSON 对象。");
  }
  const incoming = input as Partial<AppConfig> & { schemaVersion?: unknown };
  if (incoming.schemaVersion != null && incoming.schemaVersion !== CONFIG_SCHEMA_VERSION) {
    const error = new Error(`不支持的系统配置版本：${String(incoming.schemaVersion)}。`);
    Object.assign(error, { code: "CONFIG_SCHEMA_VERSION_UNSUPPORTED" });
    throw error;
  }
  return mergeConfig(defaultConfig(), incoming, options.applyRuntimeOverrides !== false);
}

function mergeConfig(
  base: AppConfig,
  incoming: Partial<AppConfig>,
  applyRuntimeOverrides: boolean
): AppConfig {
  const providerItems = incoming.providers?.items?.length ? incoming.providers.items : base.providers.items;
  const providers = {
    ...base.providers,
    ...incoming.providers,
    items: providerItems.map(normalizeProviderReasoningEffort)
  };
  const selectedProvider = providers.items.find((provider) => provider.id === providers.defaultProviderId)
    ?? providers.items.find((provider) => provider.enabled)
    ?? providers.items[0];
  const legacyVisionProvider = providers.items.find((provider) => provider.id === selectedProvider?.visionProviderId);
  const bot = mergeBotConfig(
    base.bot,
    incoming.bot as Partial<BotConfig> | undefined,
    incoming.onebot?.quoteGroupReplies,
    {
      replyModel: selectedProvider?.model ?? base.bot.replyModel,
      imageReader: {
        enabled: true,
        providerId: legacyVisionProvider?.id ?? selectedProvider?.id ?? base.bot.imageReader.providerId,
        model: selectedProvider?.visionModel?.trim()
          || legacyVisionProvider?.model
          || selectedProvider?.model
          || base.bot.imageReader.model,
        reasoningEffort: legacyVisionProvider?.reasoningEffort
          ?? selectedProvider?.reasoningEffort
          ?? base.bot.imageReader.reasoningEffort
      }
    }
  );
  const fileServer = { ...base.server, ...incoming.server };
  return {
    schemaVersion: CONFIG_SCHEMA_VERSION,
    server: {
      host: !applyRuntimeOverrides || process.env.SUNABOT_HOST == null ? fileServer.host : base.server.host,
      port: !applyRuntimeOverrides || process.env.SUNABOT_PORT == null ? fileServer.port : base.server.port
    },
    persona: {
      defaultAgentId: incoming.persona?.defaultAgentId ?? base.persona.defaultAgentId,
      name: incoming.persona?.name ?? base.persona.name,
      agentWorkspace: base.persona.agentWorkspace,
      systemPromptWorkspace: incoming.persona?.systemPromptWorkspace ?? base.persona.systemPromptWorkspace,
      systemPromptOverride: incoming.persona?.systemPromptOverride ?? base.persona.systemPromptOverride,
      ...(incoming.persona?.avatarPath ? { avatarPath: incoming.persona.avatarPath } : {})
    },
    providers,
    broadcastStorm: mergeBroadcastStormConfig(base.broadcastStorm, incoming.broadcastStorm),
    normalReply: {
      maxRetries: normalizeInteger(incoming.normalReply?.maxRetries, base.normalReply.maxRetries, 0, 10)
    },
    bot,
    onebot: { ...base.onebot, ...incoming.onebot, quoteGroupReplies: bot.quoteGroupReplies }
  };
}

function mergeBroadcastStormConfig(
  base: BroadcastStormConfig,
  incoming: Partial<BroadcastStormConfig> | undefined
): BroadcastStormConfig {
  return {
    enabled: incoming?.enabled ?? base.enabled,
    windowMinutes: normalizeInteger(incoming?.windowMinutes, base.windowMinutes, 1, 1_440),
    replyThreshold: normalizeInteger(incoming?.replyThreshold, base.replyThreshold, 1, 100),
    cooldownMinutes: normalizeInteger(incoming?.cooldownMinutes, base.cooldownMinutes, 1, 1_440),
    additionalQqIds: normalizeQqList(incoming?.additionalQqIds, base.additionalQqIds)
  };
}

function runtimePort(value: string | undefined) {
  const port = Number(value ?? "8787");
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("SUNABOT_PORT 必须是 1-65535 的整数。");
  }
  return port;
}

function normalizeProviderReasoningEffort(provider: ProviderConfig): ProviderConfig {
  const requested = isReasoningEffort(provider.reasoningEffort) ? provider.reasoningEffort : undefined;
  const legacyKind = String(provider.kind);
  const kind = (legacyKind === "openai-responses"
    ? "openai-official"
    : legacyKind === "gemini-openai"
      ? "openai-compatible"
      : legacyKind === "anthropic-openai"
        ? "anthropic-official"
        : provider.kind) as ProviderConfig["kind"];
  return {
    ...provider,
    kind,
    modelSource: provider.modelSource === "remote" || provider.modelSource === "custom"
      ? provider.modelSource
      : kind.endsWith("-compatible")
        ? "custom"
        : "remote",
    multimodal: provider.multimodal === "enabled" || provider.multimodal === "disabled" ? provider.multimodal : "auto",
    ...(typeof provider.detectedMultimodal === "boolean" ? { detectedMultimodal: provider.detectedMultimodal } : {}),
    reasoningEffort: resolveModelReasoningEffort(provider.model, requested).effort
  };
}

function mergeBotConfig(
  base: BotConfig,
  incoming: Partial<BotConfig> | undefined,
  legacyQuoteGroupReplies?: boolean,
  legacyModels: { replyModel: string; imageReader: BotImageReaderSettings } = {
    replyModel: base.replyModel,
    imageReader: base.imageReader
  }
): BotConfig {
  const bash = incoming?.bash as Partial<BotConfig["bash"]> | undefined;
  const replyModel = normalizeModelName(incoming?.replyModel, legacyModels.replyModel);
  return {
    adminQq: typeof incoming?.adminQq === "string" ? incoming.adminQq.trim() : base.adminQq,
    adminName: normalizeString(incoming?.adminName, base.adminName),
    replyModel,
    replyReasoningEffort: resolveModelReasoningEffort(
      replyModel,
      isReasoningEffort(incoming?.replyReasoningEffort) ? incoming.replyReasoningEffort : undefined,
      base.replyReasoningEffort
    ).effort,
    imageReader: mergeBotImageReaderSettings(
      base.imageReader,
      incoming?.imageReader as Partial<BotImageReaderSettings> | undefined,
      legacyModels.imageReader
    ),
    replyDebounceMs: normalizeInteger(
      incoming?.replyDebounceMs,
      base.replyDebounceMs,
      MIN_REPLY_DEBOUNCE_MS,
      MAX_REPLY_DEBOUNCE_MS
    ),
    pokeOnNoReply: incoming?.pokeOnNoReply ?? base.pokeOnNoReply,
    quoteGroupReplies: incoming?.quoteGroupReplies ?? legacyQuoteGroupReplies ?? base.quoteGroupReplies,
    quoteGroupReplyExcludedUserIds: normalizeQqList(
      incoming?.quoteGroupReplyExcludedUserIds,
      base.quoteGroupReplyExcludedUserIds
    ),
    contextMessageLimit: normalizeInteger(incoming?.contextMessageLimit, base.contextMessageLimit, 1, 120),
    emojiSendSize: [64, 128, 256, 512, 1024].includes(incoming?.emojiSendSize ?? -1)
      ? incoming!.emojiSendSize!
      : base.emojiSendSize,
    emojiSendSeparately: incoming?.emojiSendSeparately === true,
    tone: mergeBotToneSettings(base.tone, incoming?.tone as Partial<BotToneSettings> | undefined),
    director: mergeBotDirectorSettings(base.director, incoming?.director as Partial<BotDirectorSettings> | undefined),
    memory: mergeBotMemorySettings(base.memory, incoming?.memory as Partial<BotMemorySettings> | undefined),
    orchestrator: mergeBotOrchestratorSettings(base.orchestrator, incoming?.orchestrator as Partial<BotOrchestratorSettings> | undefined),
    tools: mergeBotToolSettings(base.tools, incoming?.tools as Partial<BotToolSettings> | undefined),
    bash: {
      enabled: bash?.enabled ?? base.bash.enabled,
      adminPrivateBackend: "docker",
      auditModel: normalizeModelName(bash?.auditModel, base.bash.auditModel),
      strictMode: bash?.strictMode ?? base.bash.strictMode,
      allowGroup: bash?.allowGroup ?? base.bash.allowGroup,
      adminOnly: bash?.adminOnly ?? base.bash.adminOnly,
      workspaceOnly: bash?.workspaceOnly ?? base.bash.workspaceOnly,
      blockedKeywords: ensureStringList(bash?.blockedKeywords, base.bash.blockedKeywords)
    }
  };
}

function mergeBotImageReaderSettings(
  base: BotImageReaderSettings,
  incoming: Partial<BotImageReaderSettings> | undefined,
  legacy: BotImageReaderSettings
): BotImageReaderSettings {
  const model = normalizeModelName(incoming?.model, legacy.model || base.model);
  const providerId = typeof incoming?.providerId === "string"
    ? incoming.providerId.trim()
    : legacy.providerId || base.providerId;
  return {
    enabled: incoming?.enabled ?? legacy.enabled ?? base.enabled,
    providerId,
    model,
    reasoningEffort: resolveModelReasoningEffort(
      model,
      isReasoningEffort(incoming?.reasoningEffort) ? incoming.reasoningEffort : undefined,
      legacy.reasoningEffort ?? base.reasoningEffort
    ).effort
  };
}

function mergeBotDirectorSettings(
  base: BotDirectorSettings,
  incoming: Partial<BotDirectorSettings> | undefined
): BotDirectorSettings {
  return { enabled: incoming?.enabled ?? base.enabled };
}

function mergeBotToneSettings(
  base: BotToneSettings,
  incoming: Partial<BotToneSettings> | undefined
): BotToneSettings {
  const model = normalizeModelName(incoming?.model, base.model);
  return {
    enabled: incoming?.enabled ?? base.enabled,
    segmentedReply: incoming?.segmentedReply ?? base.segmentedReply,
    followMainModel: incoming?.followMainModel ?? base.followMainModel,
    providerId: typeof incoming?.providerId === "string" ? incoming.providerId.trim() : base.providerId,
    model,
    reasoningEffort: normalizeModelEffort(model, incoming?.reasoningEffort ?? base.reasoningEffort),
    temperature: normalizeFiniteNumber(incoming?.temperature, base.temperature, 0, 2),
    maxOutputTokens: normalizeInteger(incoming?.maxOutputTokens, base.maxOutputTokens, 1, 1_000_000),
    maxRetries: normalizeInteger(incoming?.maxRetries, base.maxRetries, 0, 10)
  };
}

function mergeBotMemorySettings(base: BotMemorySettings, incoming: Partial<BotMemorySettings> | undefined): BotMemorySettings {
  const memoryModel = normalizeModelName(incoming?.memoryModel, base.memoryModel);
  const recentLimit = normalizeDreamInteger(incoming?.dreamRecentMemoryLimit, base.dreamRecentMemoryLimit, 0, 24);
  const olderLimit = normalizeDreamInteger(incoming?.dreamOlderMemoryLimit, base.dreamOlderMemoryLimit, 0, 24);
  const validSelectionSize = recentLimit + olderLimit >= 1 && recentLimit + olderLimit <= 24;
  return {
    memoryModel,
    reasoningEffort: normalizeModelEffort(memoryModel, incoming?.reasoningEffort),
    messageThreshold: normalizeInteger(incoming?.messageThreshold, base.messageThreshold, 1, 200),
    workingMemoryMaxEntries: normalizeInteger(incoming?.workingMemoryMaxEntries, base.workingMemoryMaxEntries, 1, 1000),
    dreamRecentWindowHours: normalizeDreamInteger(
      incoming?.dreamRecentWindowHours,
      base.dreamRecentWindowHours,
      1,
      720
    ),
    dreamRecentMemoryLimit: validSelectionSize ? recentLimit : base.dreamRecentMemoryLimit,
    dreamOlderMemoryLimit: validSelectionSize ? olderLimit : base.dreamOlderMemoryLimit,
    workMemoryCompressInPrompt: normalizePromptFile(incoming?.workMemoryCompressInPrompt, base.workMemoryCompressInPrompt),
    workMemoryCompressOutPrompt: normalizePromptFile(incoming?.workMemoryCompressOutPrompt, base.workMemoryCompressOutPrompt),
    userProfilePrompt: normalizePromptFile(incoming?.userProfilePrompt, base.userProfilePrompt)
  };
}

function mergeBotOrchestratorSettings(
  base: BotOrchestratorSettings,
  incoming: Partial<BotOrchestratorSettings> | undefined
): BotOrchestratorSettings {
  const model = normalizeModelName(
    incoming?.userGroupchatOrchestratorModel,
    base.userGroupchatOrchestratorModel
  );
  const groupThreadModel = normalizeModelName(
    incoming?.groupThreadModel,
    base.groupThreadModel
  );
  return {
    enabled: incoming?.enabled ?? base.enabled,
    userGroupchatOrchestratorModel: model,
    groupThreadModel,
    reasoningEffort: normalizeModelEffort(model, incoming?.reasoningEffort),
    promptFile: normalizePromptFile(incoming?.promptFile, base.promptFile),
    messageThreshold: normalizeInteger(incoming?.messageThreshold, base.messageThreshold, 0, 200),
    recentMessageWindowMs: normalizeInteger(incoming?.recentMessageWindowMs, base.recentMessageWindowMs, 1_000, 3_600_000)
  };
}

function mergeBotToolSettings(base: BotToolSettings, incoming: Partial<BotToolSettings> | undefined): BotToolSettings {
  const legacyWebsearch = incoming?.websearch as (Partial<BotToolSettings["websearch"]> & {
    model?: unknown;
    codexExecutable?: unknown;
  }) | undefined;
  const codex = incoming?.codex as Partial<BotToolSettings["codex"]> | undefined;
  const tavily = normalizeTavilySettings({
    tavilyApiKey: legacyWebsearch?.tavilyApiKey,
    tavilyApiKeys: legacyWebsearch?.tavilyApiKeys,
    tavilyApiKeyEnv: legacyWebsearch?.tavilyApiKeyEnv
  }, base.websearch);
  return {
    maxCalls: normalizeInteger(incoming?.maxCalls, base.maxCalls, 1, 100),
    overrides: mergeBotToolOverrides(base.overrides, incoming?.overrides),
    websearch: {
      provider: "tavily",
      ...tavily,
      maxResults: normalizeMaxResults(legacyWebsearch?.maxResults, base.websearch.maxResults)
    },
    codex: {
      enabled: codex?.enabled ?? base.codex.enabled,
      model: normalizeModelName(codex?.model ?? legacyWebsearch?.model, base.codex.model),
      codexExecutable: normalizeString(
        codex?.codexExecutable ?? legacyWebsearch?.codexExecutable,
        base.codex.codexExecutable
      ),
      timeoutMs: normalizeInteger(codex?.timeoutMs, base.codex.timeoutMs, 1_000, 86_400_000),
      maxConcurrency: normalizeInteger(codex?.maxConcurrency, base.codex.maxConcurrency, 1, 16)
    },
    generateImg: {
      provider: isGenerateImgProvider(incoming?.generateImg?.provider) ? incoming.generateImg.provider : base.generateImg.provider,
      size: isImageSize(incoming?.generateImg?.size) ? incoming.generateImg.size : base.generateImg.size,
      resolution: isImageResolution(incoming?.generateImg?.resolution)
        ? incoming.generateImg.resolution
        : base.generateImg.resolution,
      quality: isImageQuality(incoming?.generateImg?.quality)
        ? incoming.generateImg.quality
        : base.generateImg.quality
    }
  };
}

function mergeBotToolOverrides(
  base: BotToolSettings["overrides"],
  incoming: BotToolSettings["overrides"] | undefined
): NonNullable<BotToolSettings["overrides"]> {
  const merged: NonNullable<BotToolSettings["overrides"]> = {};
  for (const name of AGENT_TOOL_NAMES) {
    const fallback = base?.[name];
    const candidate = incoming?.[name];
    const normalized = normalizeBotToolOverride(candidate, fallback);
    if (!normalized) continue;
    if (name === "native_bash" || name === "docker_bash" || name === "codex") {
      const { enabled: _legacyEnabled, ...descriptionOnly } = normalized;
      if (descriptionOnly.description) merged[name] = descriptionOnly;
      continue;
    }
    merged[name] = normalized;
  }
  const legacyBash = normalizeBotToolOverride(
    (incoming as Record<string, BotToolOverride | undefined> | undefined)?.workspace_bash,
    (base as Record<string, BotToolOverride | undefined> | undefined)?.workspace_bash
  );
  if (legacyBash?.description && !merged.docker_bash?.description) {
    merged.docker_bash = { description: legacyBash.description };
  }
  return merged;
}

function normalizeBotToolOverride(
  candidate: BotToolOverride | undefined,
  fallback: BotToolOverride | undefined
) {
  const enabled = typeof candidate?.enabled === "boolean" ? candidate.enabled : fallback?.enabled;
  const candidateDescription = normalizeToolDescription(candidate?.description);
  const fallbackDescription = normalizeToolDescription(fallback?.description);
  const description = candidateDescription || fallbackDescription;
  if (enabled == null && !description) return undefined;
  return {
    ...(enabled == null ? {} : { enabled }),
    ...(description ? { description } : {})
  };
}

function normalizeToolDescription(value: unknown) {
  if (typeof value !== "string") return "";
  const description = value.trim();
  return description.length <= 4_000 && !description.includes("\0") ? description : "";
}

function ensureStringList(value: unknown, fallback: string[]) {
  if (!Array.isArray(value)) return fallback;
  return value.map(String).map((item) => item.trim()).filter(Boolean);
}

function normalizeQqList(value: unknown, fallback: string[]) {
  const items = ensureStringList(value, fallback)
    .filter((item) => /^\d{1,32}$/.test(item))
    .slice(0, 100);
  return [...new Set(items)];
}

function normalizeString(value: unknown, fallback: string) {
  const text = typeof value === "string" ? value.trim() : "";
  return text || fallback;
}

function normalizeMaxResults(value: unknown, fallback: number) {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) return fallback;
  return Math.min(Math.max(Math.trunc(numberValue), 1), 10);
}

function normalizeInteger(value: unknown, fallback: number, min: number, max: number) {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) return fallback;
  return Math.min(Math.max(Math.trunc(numberValue), min), max);
}

function normalizeDreamInteger(value: unknown, fallback: number, min: number, max: number) {
  if (value === undefined) return fallback;
  const numberValue = Number(value);
  return Number.isSafeInteger(numberValue) && numberValue >= min && numberValue <= max
    ? numberValue
    : fallback;
}

function normalizeFiniteNumber(value: unknown, fallback: number, min: number, max: number) {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) return fallback;
  return Math.min(Math.max(numberValue, min), max);
}

function normalizeModelName(value: unknown, fallback: string) {
  const text = typeof value === "string" ? value.trim() : "";
  return text || fallback;
}

function normalizePromptFile(value: unknown, fallback: string) {
  const text = typeof value === "string" ? value.trim() : "";
  const legacyDefault = fallback.endsWith(".json") ? `${fallback.slice(0, -5)}.md` : "";
  if (legacyDefault && text === legacyDefault) return fallback;
  return text || fallback;
}

function normalizeModelEffort(model: string, value: unknown): ReasoningEffort {
  const requested = isReasoningEffort(value) ? value : undefined;
  return resolveModelReasoningEffort(model, requested).effort;
}

function isGenerateImgProvider(value: unknown): value is BotToolSettings["generateImg"]["provider"] {
  return value === "codex-image-gen" || value === "custom";
}

function isImageSize(value: unknown): value is BotToolSettings["generateImg"]["size"] {
  return value === "1024x1024" ||
    value === "1536x1024" ||
    value === "1024x1536" ||
    value === "2048x2048" ||
    value === "2048x1152" ||
    value === "1152x2048" ||
    value === "3840x2160" ||
    value === "2160x3840";
}

function isImageResolution(value: unknown): value is BotToolSettings["generateImg"]["resolution"] {
  return value === "1K" || value === "2K" || value === "4K";
}

function isImageQuality(value: unknown): value is BotToolSettings["generateImg"]["quality"] {
  return value === "auto" || value === "low" || value === "medium" || value === "high";
}
