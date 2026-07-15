import { reactive, readonly, shallowRef, toRaw } from "vue";
import { ApiRequestError, apiRequest, apiRequestUnscoped } from "./useAdminApi";
import type {
  AppConfig,
  ConfigEnvelope,
  ConfigPatchResponse,
  ConfigSectionKey,
  ConfigSectionValueMap
} from "../types";

type SectionDrafts = { [K in ConfigSectionKey]: ConfigSectionValueMap[K] };
type StateKind = "idle" | "saving" | "saved" | "error" | "conflict" | "restart";
interface SectionState { kind: StateKind; message: string; field?: string }
export type ConfigWorkspaceScope = "agent" | "system";

const emptyConfig: AppConfig = {
  server: { host: "127.0.0.1", port: 8787 },
  persona: {
    defaultAgentId: "plana",
    agentWorkspace: "",
    systemPromptWorkspace: "workspace/business/prompts",
    systemPromptOverride: false
  },
  providers: { defaultProviderId: "", items: [] },
  broadcastStorm: {
    enabled: true,
    windowMinutes: 2,
    replyThreshold: 3,
    cooldownMinutes: 1,
    additionalQqIds: []
  },
  normalReply: { maxRetries: 3 },
  bot: {
    adminQq: "",
    adminName: "",
    pokeOnNoReply: false,
    quoteGroupReplies: true,
    quoteGroupReplyExcludedUserIds: [],
    contextMessageLimit: 48,
    memory: {
      memoryModel: "gpt-5.4-mini",
      reasoningEffort: "medium",
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
      maxCalls: 20,
      overrides: {},
      websearch: {
        provider: "tavily",
        tavilyApiKey: "",
        tavilyApiKeys: [],
        tavilyApiKeyEnv: "TAVILY_API_KEY",
        maxResults: 5
      },
      codex: {
        enabled: true,
        model: "gpt-5.4-mini",
        codexExecutable: "auto",
        timeoutMs: 900_000,
        maxConcurrency: 2
      },
      generateImg: { provider: "codex-image-gen", size: "1024x1024", resolution: "1K", quality: "high" }
    },
    bash: { enabled: true, allowGroup: false, adminOnly: true, workspaceOnly: true, blockedKeywords: ["rm"] }
  },
  onebot: {
    reverseWsPath: "/onebot/v11/ws",
    accessTokenEnv: "ONEBOT_ACCESS_TOKEN",
    autoReplyPrivate: true,
    autoReplyUserGroup: true,
    autoReplyBotGroup: false,
    quoteGroupReplies: true,
    mentionNames: [],
    commandPrefixes: []
  }
};

const envelope = shallowRef<ConfigEnvelope | null>(null);
const loading = shallowRef(false);
const state = reactive<Record<ConfigSectionKey, SectionState>>({
  server: idle(), persona: idle(), providers: idle(), normalReply: idle(), bot: idle(), memory: idle(),
  broadcastStorm: idle(), orchestrator: idle(), tools: idle(), bash: idle(), onebot: idle()
});
const drafts = reactive<SectionDrafts>(valuesFromConfig(emptyConfig));
const baselines = reactive<SectionDrafts>(valuesFromConfig(emptyConfig));

async function load(
  options: { preserveDirty?: boolean; discardDirtySection?: ConfigSectionKey } = {},
  scope: ConfigWorkspaceScope = "agent"
) {
  const dirtyBefore = new Map<ConfigSectionKey, boolean>();
  const savedDrafts = new Map<ConfigSectionKey, unknown>();
  for (const key of sectionKeys) {
    dirtyBefore.set(key, isDirty(key));
    savedDrafts.set(key, clone(drafts[key]));
  }
  loading.value = true;
  try {
    const result = await requestFor(scope)<ConfigEnvelope>("/api/config");
    envelope.value = result;
    const values = valuesFromConfig(result.config);
    for (const key of sectionKeys) {
      setSection(baselines, key, values[key]);
      if (options.preserveDirty && key !== options.discardDirtySection && dirtyBefore.get(key)) setSection(drafts, key, savedDrafts.get(key) as SectionDrafts[typeof key]);
      else setSection(drafts, key, values[key]);
      state[key] = idle();
    }
  } finally {
    loading.value = false;
  }
}

async function save<K extends ConfigSectionKey>(key: K, scope: ConfigWorkspaceScope = "agent") {
  const current = envelope.value;
  if (!current) return;
  const submittedDraft = clone(drafts[key]);
  if (key === "onebot") {
    (submittedDraft as SectionDrafts["onebot"]).autoReplyUserGroup = baselines.onebot.autoReplyUserGroup;
  }
  state[key] = { kind: "saving", message: "保存中" };
  try {
    const result = await requestFor(scope)<ConfigPatchResponse>(`/api/config/${key}`, {
      method: "PATCH",
      body: JSON.stringify({ revision: current.revision, value: submittedDraft })
    });
    const dirtyBefore = new Map(sectionKeys.map((section) => [section, isDirty(section)]));
    const savedDrafts = new Map(sectionKeys.map((section) => [section, clone(drafts[section])]));
    envelope.value = result;
    const values = valuesFromConfig(result.config);
    for (const section of sectionKeys) {
      setSection(baselines, section, values[section]);
      if (section === key) {
        const currentDraft = savedDrafts.get(section) as SectionDrafts[typeof section];
        const unchangedSinceSubmit = JSON.stringify(currentDraft) === JSON.stringify(submittedDraft);
        setSection(drafts, section, unchangedSinceSubmit ? values[section] : currentDraft);
      } else if (!dirtyBefore.get(section)) {
        setSection(drafts, section, values[section]);
      } else {
        setSection(drafts, section, savedDrafts.get(section) as SectionDrafts[typeof section]);
      }
    }
    const restart = result.applyMode === "restart" || Boolean(result.restartRequiredFields?.length);
    const hasNewEdits = key === "onebot" ? isOneBotSettingsDirty() : isDirty(key);
    state[key] = restart
      ? { kind: "restart", message: hasNewEdits ? "已保存，重启后生效；还有未保存的修改" : "已保存，重启后生效" }
      : hasNewEdits
        ? { kind: "idle", message: "已保存，还有未保存的修改" }
        : { kind: "saved", message: "已保存" };
  } catch (caught) {
    if (caught instanceof ApiRequestError && caught.status === 409) {
      state[key] = { kind: "conflict", message: "设置已更新，请加载最新内容" };
    } else {
      state[key] = {
        kind: "error",
        message: caught instanceof Error ? caught.message : "保存失败",
        ...(caught instanceof ApiRequestError && caught.field ? { field: caught.field } : {})
      };
    }
  }
}

async function saveGroupReply(scope: ConfigWorkspaceScope = "agent") {
  const current = envelope.value;
  if (!current) return;
  const submittedOrchestrator = clone(drafts.orchestrator);
  const submittedEnabled = drafts.onebot.autoReplyUserGroup;
  state.orchestrator = { kind: "saving", message: "保存中" };
  try {
    const result = await requestFor(scope)<ConfigPatchResponse>("/api/config/group-reply", {
      method: "PATCH",
      body: JSON.stringify({
        revision: current.revision,
        value: {
          enabled: submittedEnabled,
          orchestrator: submittedOrchestrator
        }
      })
    });
    const dirtyBefore = new Map(sectionKeys.map((section) => [section, isDirty(section)]));
    const savedDrafts = new Map(sectionKeys.map((section) => [section, clone(drafts[section])]));
    envelope.value = result;
    const values = valuesFromConfig(result.config);
    for (const section of sectionKeys) {
      setSection(baselines, section, values[section]);
      if (section === "orchestrator") {
        const currentDraft = savedDrafts.get(section) as SectionDrafts["orchestrator"];
        const unchangedSinceSubmit = JSON.stringify(currentDraft) === JSON.stringify(submittedOrchestrator);
        setSection(drafts, section, unchangedSinceSubmit ? values[section] : currentDraft);
      } else if (section === "onebot") {
        const currentDraft = savedDrafts.get(section) as SectionDrafts["onebot"];
        const nextDraft = clone(currentDraft);
        if (currentDraft.autoReplyUserGroup === submittedEnabled) {
          nextDraft.autoReplyUserGroup = values.onebot.autoReplyUserGroup;
        }
        setSection(drafts, section, nextDraft);
      } else if (!dirtyBefore.get(section)) {
        setSection(drafts, section, values[section]);
      } else {
        setSection(drafts, section, savedDrafts.get(section) as SectionDrafts[typeof section]);
      }
    }
    const hasNewEdits = isGroupReplyDirty();
    state.orchestrator = hasNewEdits
      ? { kind: "idle", message: "已保存，还有未保存的修改" }
      : { kind: "saved", message: "已保存" };
  } catch (caught) {
    if (caught instanceof ApiRequestError && caught.status === 409) {
      state.orchestrator = { kind: "conflict", message: "设置已更新，请加载最新内容" };
    } else {
      state.orchestrator = {
        kind: "error",
        message: caught instanceof Error ? caught.message : "保存失败",
        ...(caught instanceof ApiRequestError && caught.field ? { field: caught.field } : {})
      };
    }
  }
}

function discard(key: ConfigSectionKey) {
  const groupEnabled = drafts.onebot.autoReplyUserGroup;
  setSection(drafts, key, baselines[key]);
  if (key === "onebot") drafts.onebot.autoReplyUserGroup = groupEnabled;
  state[key] = idle();
}

function isDirty(key: ConfigSectionKey) {
  return JSON.stringify(drafts[key]) !== JSON.stringify(baselines[key]);
}

function isGroupReplyDirty() {
  return isDirty("orchestrator") ||
    drafts.onebot.autoReplyUserGroup !== baselines.onebot.autoReplyUserGroup;
}

function isOneBotSettingsDirty() {
  return isReplyBehaviorDirty() || isOneBotConnectionDirty();
}

function isReplyBehaviorDirty() {
  return drafts.onebot.autoReplyPrivate !== baselines.onebot.autoReplyPrivate ||
    drafts.onebot.autoReplyBotGroup !== baselines.onebot.autoReplyBotGroup ||
    JSON.stringify(drafts.onebot.mentionNames) !== JSON.stringify(baselines.onebot.mentionNames) ||
    JSON.stringify(drafts.onebot.commandPrefixes) !== JSON.stringify(baselines.onebot.commandPrefixes);
}

function isNoReplyPokeDirty() {
  return drafts.bot.pokeOnNoReply !== baselines.bot.pokeOnNoReply;
}

function discardNoReplyPoke() {
  drafts.bot.pokeOnNoReply = baselines.bot.pokeOnNoReply;
  state.bot = idle();
}

function isOneBotConnectionDirty() {
  return drafts.onebot.reverseWsPath !== baselines.onebot.reverseWsPath ||
    drafts.onebot.accessTokenEnv !== baselines.onebot.accessTokenEnv;
}

function discardReplyBehavior() {
  drafts.onebot.autoReplyPrivate = baselines.onebot.autoReplyPrivate;
  drafts.onebot.autoReplyBotGroup = baselines.onebot.autoReplyBotGroup;
  drafts.onebot.mentionNames = clone(baselines.onebot.mentionNames);
  drafts.onebot.commandPrefixes = clone(baselines.onebot.commandPrefixes);
  state.onebot = idle();
}

function discardOneBotConnection() {
  drafts.onebot.reverseWsPath = baselines.onebot.reverseWsPath;
  drafts.onebot.accessTokenEnv = baselines.onebot.accessTokenEnv;
  state.onebot = idle();
}

function discardGroupReply() {
  setSection(drafts, "orchestrator", baselines.orchestrator);
  drafts.onebot.autoReplyUserGroup = baselines.onebot.autoReplyUserGroup;
  state.orchestrator = idle();
}

function valuesFromConfig(config: AppConfig): SectionDrafts {
  return {
    server: clone(config.server),
    persona: { agentWorkspace: config.persona.agentWorkspace },
    providers: clone(config.providers),
    broadcastStorm: clone(config.broadcastStorm),
    normalReply: clone(config.normalReply),
    bot: {
      adminQq: config.bot.adminQq,
      adminName: config.bot.adminName,
      pokeOnNoReply: config.bot.pokeOnNoReply,
      quoteGroupReplies: config.bot.quoteGroupReplies,
      quoteGroupReplyExcludedUserIds: [...(config.bot.quoteGroupReplyExcludedUserIds ?? [])],
      contextMessageLimit: config.bot.contextMessageLimit
    },
    memory: clone(config.bot.memory),
    orchestrator: clone(config.bot.orchestrator),
    tools: {
      ...clone(config.bot.tools),
      overrides: clone(config.bot.tools.overrides ?? {}),
      websearch: {
        ...clone(config.bot.tools.websearch),
        removeTavilyApiKeyIndexes: []
      }
    },
    bash: clone(config.bot.bash),
    onebot: {
      reverseWsPath: config.onebot.reverseWsPath,
      accessTokenEnv: config.onebot.accessTokenEnv,
      autoReplyPrivate: config.onebot.autoReplyPrivate,
      autoReplyUserGroup: config.onebot.autoReplyUserGroup,
      autoReplyBotGroup: config.onebot.autoReplyBotGroup,
      mentionNames: [...config.onebot.mentionNames],
      commandPrefixes: [...config.onebot.commandPrefixes]
    }
  };
}

function setSection<K extends ConfigSectionKey>(target: SectionDrafts, key: K, value: SectionDrafts[K] | unknown) {
  (target as Record<ConfigSectionKey, unknown>)[key] = clone(value);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(toRaw(value))) as T;
}

function idle() {
  return { kind: "idle" as const, message: "" };
}

export const sectionKeys: ConfigSectionKey[] = ["server", "persona", "providers", "broadcastStorm", "normalReply", "bot", "memory", "orchestrator", "tools", "bash", "onebot"];

function requestFor(scope: ConfigWorkspaceScope) {
  return scope === "system" ? apiRequestUnscoped : apiRequest;
}

export function useConfigWorkspace(scope: ConfigWorkspaceScope = "agent") {
  return {
    envelope: readonly(envelope),
    drafts,
    state,
    loading: readonly(loading),
    load: (options?: { preserveDirty?: boolean; discardDirtySection?: ConfigSectionKey }) => load(options, scope),
    save: <K extends ConfigSectionKey>(key: K) => save(key, scope),
    saveGroupReply: () => saveGroupReply(scope),
    discard,
    discardGroupReply,
    isDirty,
    isGroupReplyDirty,
    isOneBotSettingsDirty,
    isReplyBehaviorDirty,
    isNoReplyPokeDirty,
    isOneBotConnectionDirty,
    discardNoReplyPoke,
    discardReplyBehavior,
    discardOneBotConnection
  };
}
