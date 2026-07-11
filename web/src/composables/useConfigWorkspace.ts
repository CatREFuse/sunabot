import { reactive, readonly, shallowRef, toRaw } from "vue";
import { ApiRequestError, apiRequest } from "./useAdminApi";
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

const emptyConfig: AppConfig = {
  server: { host: "127.0.0.1", port: 8787 },
  persona: { defaultAgentId: "plana", agentWorkspace: "", memoryLimit: 100 },
  providers: { defaultProviderId: "", items: [] },
  bot: {
    adminQq: "",
    adminName: "",
    quoteGroupReplies: true,
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
  server: idle(), persona: idle(), providers: idle(), bot: idle(), memory: idle(),
  orchestrator: idle(), tools: idle(), bash: idle(), onebot: idle()
});
const drafts = reactive<SectionDrafts>(valuesFromConfig(emptyConfig));
const baselines = reactive<SectionDrafts>(valuesFromConfig(emptyConfig));

async function load(options: { preserveDirty?: boolean; discardDirtySection?: ConfigSectionKey } = {}) {
  const dirtyBefore = new Map<ConfigSectionKey, boolean>();
  const savedDrafts = new Map<ConfigSectionKey, unknown>();
  for (const key of sectionKeys) {
    dirtyBefore.set(key, isDirty(key));
    savedDrafts.set(key, clone(drafts[key]));
  }
  loading.value = true;
  try {
    const result = await apiRequest<ConfigEnvelope>("/api/config");
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

async function save<K extends ConfigSectionKey>(key: K) {
  const current = envelope.value;
  if (!current) return;
  const submittedDraft = clone(drafts[key]);
  if (key === "onebot") {
    (submittedDraft as SectionDrafts["onebot"]).autoReplyUserGroup = baselines.onebot.autoReplyUserGroup;
  }
  state[key] = { kind: "saving", message: "[SAVING...]" };
  try {
    const result = await apiRequest<ConfigPatchResponse>(`/api/config/${key}`, {
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
      ? { kind: "restart", message: hasNewEdits ? "[SAVED · RESTART REQUIRED · UNSAVED CHANGES]" : "[SAVED · RESTART REQUIRED]" }
      : hasNewEdits
        ? { kind: "idle", message: "[SAVED · UNSAVED CHANGES]" }
        : { kind: "saved", message: "[SAVED]" };
  } catch (caught) {
    if (caught instanceof ApiRequestError && caught.status === 409) {
      state[key] = { kind: "conflict", message: "[CONFLICT · LOAD LATEST CONFIG]" };
    } else {
      state[key] = {
        kind: "error",
        message: `[ERROR: ${caught instanceof Error ? caught.message : "保存失败"}]`,
        ...(caught instanceof ApiRequestError && caught.field ? { field: caught.field } : {})
      };
    }
  }
}

async function saveGroupReply() {
  const current = envelope.value;
  if (!current) return;
  const submittedOrchestrator = clone(drafts.orchestrator);
  const submittedEnabled = drafts.onebot.autoReplyUserGroup;
  state.orchestrator = { kind: "saving", message: "[SAVING...]" };
  try {
    const result = await apiRequest<ConfigPatchResponse>("/api/config/group-reply", {
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
      ? { kind: "idle", message: "[SAVED · UNSAVED CHANGES]" }
      : { kind: "saved", message: "[SAVED]" };
  } catch (caught) {
    if (caught instanceof ApiRequestError && caught.status === 409) {
      state.orchestrator = { kind: "conflict", message: "[CONFLICT · LOAD LATEST CONFIG]" };
    } else {
      state.orchestrator = {
        kind: "error",
        message: `[ERROR: ${caught instanceof Error ? caught.message : "保存失败"}]`,
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
  const draft = clone(drafts.onebot);
  const baseline = clone(baselines.onebot);
  draft.autoReplyUserGroup = baseline.autoReplyUserGroup;
  return JSON.stringify(draft) !== JSON.stringify(baseline);
}

function discardGroupReply() {
  setSection(drafts, "orchestrator", baselines.orchestrator);
  drafts.onebot.autoReplyUserGroup = baselines.onebot.autoReplyUserGroup;
  state.orchestrator = idle();
}

function valuesFromConfig(config: AppConfig): SectionDrafts {
  return {
    server: clone(config.server),
    persona: { agentWorkspace: config.persona.agentWorkspace, memoryLimit: config.persona.memoryLimit },
    providers: clone(config.providers),
    bot: {
      adminQq: config.bot.adminQq,
      adminName: config.bot.adminName,
      quoteGroupReplies: config.bot.quoteGroupReplies,
      contextMessageLimit: config.bot.contextMessageLimit
    },
    memory: clone(config.bot.memory),
    orchestrator: clone(config.bot.orchestrator),
    tools: {
      ...clone(config.bot.tools),
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

export const sectionKeys: ConfigSectionKey[] = ["server", "persona", "providers", "bot", "memory", "orchestrator", "tools", "bash", "onebot"];

export function useConfigWorkspace() {
  return {
    envelope: readonly(envelope),
    drafts,
    state,
    loading: readonly(loading),
    load,
    save,
    saveGroupReply,
    discard,
    discardGroupReply,
    isDirty,
    isGroupReplyDirty,
    isOneBotSettingsDirty
  };
}
