import fs from "node:fs/promises";
import path from "node:path";
import dotenv from "dotenv";
import {
  AppConfig,
  BotConfig,
  BotMemorySettings,
  BotOrchestratorSettings,
  BotToolSettings,
  ProviderConfig,
  ReasoningEffort
} from "./types.js";
import { isReasoningEffort, resolveModelReasoningEffort } from "./admin/models.js";
import {
  DEFAULT_TAVILY_API_KEY_ENV,
  normalizeTavilySettings
} from "./webSearchSettings.js";

const rootDir = process.cwd();
const workspaceDir = resolveWorkspaceDir(process.env.SUNABOT_WORKSPACE);
const AUTO_CODEX_EXECUTABLE = "auto";

dotenv.config({ path: path.join(workspaceDir, ".env"), override: false });

export function getRootDir() {
  return rootDir;
}

export function getWorkspaceDir() {
  return workspaceDir;
}

export function getWorkspacePath(...segments: string[]) {
  return path.join(workspaceDir, ...segments);
}

export function getConfigPath() {
  return process.env.SUNABOT_CONFIG ?? getWorkspacePath("config/sunabot.json");
}

export function defaultConfig(): AppConfig {
  const host = process.env.SUNABOT_HOST ?? "127.0.0.1";
  const port = Number(process.env.SUNABOT_PORT ?? "8787");
  const planaConfigEnv = "workspace/.env";

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
      envFile: planaConfigEnv,
      temperature: 0.7,
      maxOutputTokens: 2400,
      reasoningEffort: "medium"
    },
    {
      id: "openai-api",
      label: "OpenAI API",
      kind: "openai-responses",
      enabled: true,
      model: "gpt-5.5",
      imageModel: "gpt-image-2",
      baseUrl: "https://api.openai.com",
      apiKeyEnv: "OPENAI_API_KEY",
      envFile: "workspace/.env",
      temperature: 0.7,
      maxOutputTokens: 2400,
      reasoningEffort: "medium"
    }
  ];

  return {
    server: { host, port },
    persona: {
      defaultAgentId: "plana",
      agentWorkspace: "workspace/agents/plana",
      memoryLimit: 32
    },
    providers: {
      defaultProviderId: providers[0]?.id ?? "open-arona-codex",
      items: providers
    },
    bot: {
      adminQq: "171419991",
      adminName: "猫老师",
      quoteGroupReplies: true,
      contextMessageLimit: 48,
      memory: {
        memoryModel: "gpt-5.4-mini",
        reasoningEffort: "low",
        messageThreshold: 48,
        workingMemoryMaxEntries: 100,
        workMemoryCompressInPrompt: "work_memory_compress_in.json",
        workMemoryCompressOutPrompt: "work_memory_compress_out.json",
        userProfilePrompt: "user_profile_prompt.json"
      },
      orchestrator: {
        enabled: false,
        userGroupchatOrchestratorModel: "gpt-5.4-mini",
        reasoningEffort: "medium",
        promptFile: "user_groupchat_orchestrator.json",
        messageThreshold: 10,
        recentMessageWindowMs: 60_000
      },
      tools: {
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
        enabled: true,
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
  const configPath = getConfigPath();
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.mkdir(getWorkspacePath("agents/plana"), { recursive: true });
  await fs.mkdir(getWorkspacePath("artifacts/images"), { recursive: true });
}

export async function loadConfig(): Promise<AppConfig> {
  await ensureWorkspace();
  const configPath = getConfigPath();

  try {
    const raw = await fs.readFile(configPath, "utf8");
    return mergeConfig(defaultConfig(), JSON.parse(raw) as Partial<AppConfig>);
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
  await fs.writeFile(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  try {
    await fs.rename(temporaryPath, configPath);
  } catch (error) {
    await fs.rm(temporaryPath, { force: true });
    throw error;
  }
}

export function resolveProjectPath(inputPath: string | undefined) {
  if (!inputPath) return undefined;
  if (path.isAbsolute(inputPath)) return inputPath;
  const normalized = inputPath.replace(/\\/g, "/");
  if (normalized === ".env") return getWorkspacePath(".env");
  if (normalized === "workspace") return workspaceDir;
  if (normalized.startsWith("workspace/")) return getWorkspacePath(normalized.slice("workspace/".length));
  return path.join(rootDir, inputPath);
}

function resolveWorkspaceDir(configured: string | undefined) {
  const value = configured?.trim();
  if (!value) return path.join(rootDir, "workspace");
  return path.isAbsolute(value) ? path.normalize(value) : path.resolve(rootDir, value);
}

export function getDefaultProvider(config: AppConfig) {
  return (
    config.providers.items.find((provider) => provider.id === config.providers.defaultProviderId) ??
    config.providers.items.find((provider) => provider.enabled) ??
    config.providers.items[0]
  );
}

function mergeConfig(base: AppConfig, incoming: Partial<AppConfig>): AppConfig {
  const bot = mergeBotConfig(base.bot, incoming.bot as Partial<BotConfig> | undefined, incoming.onebot?.quoteGroupReplies);
  const providerItems = incoming.providers?.items?.length ? incoming.providers.items : base.providers.items;
  return {
    ...base,
    ...incoming,
    server: { ...base.server, ...incoming.server },
    persona: { ...base.persona, ...incoming.persona },
    providers: {
      ...base.providers,
      ...incoming.providers,
      items: providerItems.map(normalizeProviderReasoningEffort)
    },
    bot,
    onebot: { ...base.onebot, ...incoming.onebot, quoteGroupReplies: bot.quoteGroupReplies }
  };
}

function normalizeProviderReasoningEffort(provider: ProviderConfig): ProviderConfig {
  const requested = isReasoningEffort(provider.reasoningEffort) ? provider.reasoningEffort : undefined;
  return {
    ...provider,
    reasoningEffort: resolveModelReasoningEffort(provider.model, requested).effort
  };
}

function mergeBotConfig(base: BotConfig, incoming: Partial<BotConfig> | undefined, legacyQuoteGroupReplies?: boolean): BotConfig {
  const bash = incoming?.bash as Partial<BotConfig["bash"]> | undefined;
  return {
    adminQq: typeof incoming?.adminQq === "string" ? incoming.adminQq.trim() : base.adminQq,
    adminName: normalizeString(incoming?.adminName, base.adminName),
    quoteGroupReplies: incoming?.quoteGroupReplies ?? legacyQuoteGroupReplies ?? base.quoteGroupReplies,
    contextMessageLimit: normalizeInteger(incoming?.contextMessageLimit, base.contextMessageLimit, 1, 120),
    memory: mergeBotMemorySettings(base.memory, incoming?.memory as Partial<BotMemorySettings> | undefined),
    orchestrator: mergeBotOrchestratorSettings(base.orchestrator, incoming?.orchestrator as Partial<BotOrchestratorSettings> | undefined),
    tools: mergeBotToolSettings(base.tools, incoming?.tools as Partial<BotToolSettings> | undefined),
    bash: {
      enabled: bash?.enabled ?? base.bash.enabled,
      allowGroup: bash?.allowGroup ?? base.bash.allowGroup,
      adminOnly: bash?.adminOnly ?? base.bash.adminOnly,
      workspaceOnly: bash?.workspaceOnly ?? base.bash.workspaceOnly,
      blockedKeywords: ensureStringList(bash?.blockedKeywords, base.bash.blockedKeywords)
    }
  };
}

function mergeBotMemorySettings(base: BotMemorySettings, incoming: Partial<BotMemorySettings> | undefined): BotMemorySettings {
  const memoryModel = normalizeModelName(incoming?.memoryModel, base.memoryModel);
  return {
    memoryModel,
    reasoningEffort: normalizeModelEffort(memoryModel, incoming?.reasoningEffort),
    messageThreshold: normalizeInteger(incoming?.messageThreshold, base.messageThreshold, 1, 200),
    workingMemoryMaxEntries: normalizeInteger(incoming?.workingMemoryMaxEntries, base.workingMemoryMaxEntries, 1, 1000),
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
  return {
    enabled: incoming?.enabled ?? base.enabled,
    userGroupchatOrchestratorModel: model,
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

function ensureStringList(value: unknown, fallback: string[]) {
  if (!Array.isArray(value)) return fallback;
  return value.map(String).map((item) => item.trim()).filter(Boolean);
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
