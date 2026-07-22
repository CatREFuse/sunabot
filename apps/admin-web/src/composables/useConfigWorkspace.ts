import {
  getCurrentScope,
  onScopeDispose,
  reactive,
  readonly,
  shallowRef,
  toRaw
} from "vue";
import { activeAgentId } from "./agentScope";
import { ApiRequestError, apiRequest, apiRequestUnscoped } from "./useAdminApi";
import type {
  AppConfig,
  ConfigEnvelope,
  ConfigPatchResponse,
  ConfigSectionKey,
  ConfigSectionValueMap
} from "../types";

type SectionDrafts = { [K in ConfigSectionKey]: ConfigSectionValueMap[K] };
type StateKind = "idle" | "waiting" | "saving" | "saved" | "error" | "conflict" | "restart";
type SaveTarget = ConfigSectionKey | "groupReply";
interface SectionState { kind: StateKind; message: string; field?: string }
interface RequestContext { generation: number; agentId: string; signal: AbortSignal }
export type ConfigWorkspaceScope = "agent" | "system";

const emptyConfig: AppConfig = {
  schemaVersion: 1,
  server: { host: "127.0.0.1", port: 8787 },
  persona: {
    defaultAgentId: "plana",
    name: "",
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
    replyDebounceMs: 5_000,
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
    memory: {
      memoryModel: "gpt-5.4-mini",
      reasoningEffort: "medium",
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
    mentionNames: [],
    commandPrefixes: []
  }
};

export const sectionKeys: ConfigSectionKey[] = [
  "server",
  "persona",
  "providers",
  "broadcastStorm",
  "normalReply",
  "bot",
  "tone",
  "memory",
  "orchestrator",
  "tools",
  "bash",
  "onebot"
];

export function useConfigWorkspace(scope: ConfigWorkspaceScope = "agent") {
  const envelope = shallowRef<ConfigEnvelope | null>(null);
  const loading = shallowRef(false);
  const state = reactive<Record<ConfigSectionKey, SectionState>>({
    server: idle(), persona: idle(), providers: idle(), normalReply: idle(), bot: idle(), tone: idle(), memory: idle(),
    broadcastStorm: idle(), orchestrator: idle(), tools: idle(), bash: idle(), onebot: idle()
  });
  const drafts = reactive<SectionDrafts>(valuesFromConfig(emptyConfig));
  const baselines = reactive<SectionDrafts>(valuesFromConfig(emptyConfig));
  const pendingTargets = new Set<SaveTarget>();
  let loaded = false;
  let generation = 0;
  let contextAgentId = scope === "agent" ? activeAgentId() : "";
  let contextController = new AbortController();
  let drainPromise: Promise<void> | undefined;

  if (getCurrentScope()) onScopeDispose(cancel);

  async function load(options: { preserveDirty?: boolean; agentId?: string } = {}) {
    const dirtyBefore = new Map(sectionKeys.map((key) => [key, isDirty(key)]));
    const savedDrafts = new Map(sectionKeys.map((key) => [key, clone(drafts[key])]));
    beginContext(options.agentId);
    const context = currentContext();
    loading.value = true;
    try {
      const result = await request<ConfigEnvelope>(context, "/api/config");
      if (!isCurrent(context)) return;
      applyLoadedEnvelope(result, options.preserveDirty ? dirtyBefore : undefined, savedDrafts);
      loaded = true;
      if (options.preserveDirty) scheduleAllDirty();
    } catch (caught) {
      if (isAbort(caught) || !isCurrent(context)) return;
      throw caught;
    } finally {
      if (isCurrent(context)) loading.value = false;
    }
  }

  function commit(key: ConfigSectionKey) {
    if (!loaded) return Promise.resolve();
    scheduleForSection(key);
    return startDrain();
  }

  function scheduleForSection(key: ConfigSectionKey) {
    if (key === "orchestrator") {
      schedule("groupReply");
      return;
    }
    if (key === "onebot") {
      if (drafts.onebot.autoReplyUserGroup !== baselines.onebot.autoReplyUserGroup) schedule("groupReply");
      if (isReplyBehaviorDirty() || isOneBotConnectionDirty()) schedule("onebot");
      return;
    }
    schedule(key);
  }

  function schedule(target: SaveTarget) {
    const key = stateKey(target);
    if (!targetDirty(target) && state[key].kind !== "saving") return;
    pendingTargets.add(target);
    if (state[key].kind !== "saving") state[key] = { kind: "waiting", message: "等待保存" };
  }

  function scheduleAllDirty() {
    for (const key of sectionKeys) scheduleForSection(key);
  }

  function startDrain() {
    if (drainPromise) return drainPromise;
    const context = currentContext();
    const running = drain(context).finally(async () => {
      if (drainPromise !== running) return;
      drainPromise = undefined;
      if (isCurrent(context) && pendingTargets.size > 0) await startDrain();
    });
    drainPromise = running;
    return running;
  }

  async function drain(context: RequestContext) {
    while (isCurrent(context) && pendingTargets.size > 0) {
      const [target] = pendingTargets;
      if (!target) return;
      pendingTargets.delete(target);
      if (!targetDirty(target)) {
        const key = stateKey(target);
        if (state[key].kind === "waiting") state[key] = idle();
        continue;
      }
      await saveTarget(target, context);
    }
  }

  async function saveTarget(target: SaveTarget, context: RequestContext) {
    const current = envelope.value;
    if (!current || !isCurrent(context)) return;
    const submitted = target === "groupReply"
      ? {
          enabled: drafts.onebot.autoReplyUserGroup,
          orchestrator: clone(drafts.orchestrator)
        }
      : submittedSection(target);
    const key = stateKey(target);
    state[key] = { kind: "saving", message: "保存中" };
    try {
      let result: ConfigPatchResponse;
      try {
        result = await patchTarget(target, submitted, current.revision, context);
      } catch (caught) {
        if (!(caught instanceof ApiRequestError) || caught.status !== 409) throw caught;
        await refreshRevision(context);
        if (!isCurrent(context) || !envelope.value) return;
        result = await patchTarget(target, submitted, envelope.value.revision, context);
      }
      if (!isCurrent(context)) return;
      applySaveResult(target, submitted, result);
    } catch (caught) {
      if (isAbort(caught) || !isCurrent(context)) return;
      state[key] = caught instanceof ApiRequestError && caught.status === 409
        ? { kind: "conflict", message: "保存冲突，请修改后重试" }
        : {
            kind: "error",
            message: caught instanceof Error ? caught.message : "保存失败",
            ...(caught instanceof ApiRequestError && caught.field ? { field: caught.field } : {})
          };
    }
  }

  function submittedSection<K extends ConfigSectionKey>(key: K) {
    const submitted = clone(drafts[key]);
    if (key === "onebot") {
      (submitted as SectionDrafts["onebot"]).autoReplyUserGroup = baselines.onebot.autoReplyUserGroup;
    }
    return submitted;
  }

  function patchTarget(target: SaveTarget, submitted: unknown, revision: string, context: RequestContext) {
    const path = target === "groupReply" ? "/api/config/group-reply" : `/api/config/${target}`;
    return request<ConfigPatchResponse>(context, path, {
      method: "PATCH",
      body: JSON.stringify({ revision, value: submitted })
    });
  }

  async function refreshRevision(context: RequestContext) {
    const result = await request<ConfigEnvelope>(context, "/api/config");
    if (!isCurrent(context)) return;
    const dirtyBefore = new Map(sectionKeys.map((key) => [key, isDirty(key)]));
    const savedDrafts = new Map(sectionKeys.map((key) => [key, clone(drafts[key])]));
    applyLoadedEnvelope(result, dirtyBefore, savedDrafts, false);
  }

  function applyLoadedEnvelope(
    result: ConfigEnvelope,
    dirtyBefore?: Map<ConfigSectionKey, boolean>,
    savedDrafts = new Map<ConfigSectionKey, unknown>(),
    resetState = true
  ) {
    const values = valuesFromConfig(result.config);
    envelope.value = result;
    for (const key of sectionKeys) {
      setSection(baselines, key, values[key]);
      if (dirtyBefore?.get(key)) setSection(drafts, key, savedDrafts.get(key) as SectionDrafts[typeof key]);
      else setSection(drafts, key, values[key]);
      if (resetState) state[key] = idle();
    }
  }

  function applySaveResult(target: SaveTarget, submitted: unknown, result: ConfigPatchResponse) {
    const dirtyBefore = new Map(sectionKeys.map((key) => [key, isDirty(key)]));
    const savedDrafts = new Map(sectionKeys.map((key) => [key, clone(drafts[key])]));
    const values = valuesFromConfig(result.config);
    envelope.value = result;
    for (const section of sectionKeys) {
      setSection(baselines, section, values[section]);
      if (target === "groupReply" && section === "orchestrator") {
        const currentDraft = savedDrafts.get(section) as SectionDrafts["orchestrator"];
        const submittedDraft = (submitted as { orchestrator: SectionDrafts["orchestrator"] }).orchestrator;
        setSection(drafts, section, same(currentDraft, submittedDraft) ? values[section] : currentDraft);
      } else if (target === "groupReply" && section === "onebot") {
        const currentDraft = savedDrafts.get(section) as SectionDrafts["onebot"];
        const nextDraft = clone(currentDraft);
        if (currentDraft.autoReplyUserGroup === (submitted as { enabled: boolean }).enabled) {
          nextDraft.autoReplyUserGroup = values.onebot.autoReplyUserGroup;
        }
        setSection(drafts, section, nextDraft);
      } else if (target !== "groupReply" && section === target) {
        const currentDraft = savedDrafts.get(section) as SectionDrafts[typeof section];
        setSection(drafts, section, same(currentDraft, submitted) ? values[section] : currentDraft);
      } else if (dirtyBefore.get(section)) {
        setSection(drafts, section, savedDrafts.get(section) as SectionDrafts[typeof section]);
      } else {
        setSection(drafts, section, values[section]);
      }
    }
    const key = stateKey(target);
    const hasNewEdits = targetDirty(target);
    const restart = result.applyMode === "restart" || Boolean(result.restartRequiredFields?.length);
    state[key] = restart
      ? { kind: "restart", message: hasNewEdits ? "重启后生效；还有修改待保存" : "重启后生效" }
      : hasNewEdits
        ? { kind: "waiting", message: "还有修改待保存" }
        : { kind: "saved", message: "" };
  }

  async function flush() {
    if (!loaded) return true;
    if (drainPromise) await drainPromise;
    if (sectionKeys.some((key) => isDirty(key) && (state[key].kind === "error" || state[key].kind === "conflict"))) {
      return false;
    }
    if (isGroupReplyDirty() && (state.orchestrator.kind === "error" || state.orchestrator.kind === "conflict")) {
      return false;
    }
    scheduleAllDirty();
    await startDrain();
    return !sectionKeys.some((key) => isDirty(key));
  }

  function cancel() {
    generation += 1;
    loaded = false;
    pendingTargets.clear();
    contextController.abort();
    contextController = new AbortController();
    drainPromise = undefined;
  }

  function beginContext(agentId?: string) {
    cancel();
    contextAgentId = scope === "agent" ? (agentId?.trim() || activeAgentId()) : "";
  }

  function currentContext(): RequestContext {
    return {
      generation,
      agentId: contextAgentId,
      signal: contextController.signal
    };
  }

  function isCurrent(context: RequestContext) {
    return context.generation === generation
      && context.agentId === contextAgentId
      && !context.signal.aborted;
  }

  function request<T>(context: RequestContext, path: string, init: RequestInit = {}) {
    if (scope === "system") return apiRequestUnscoped<T>(path, { ...init, signal: context.signal });
    const separator = path.includes("?") ? "&" : "?";
    return apiRequest<T>(`${path}${separator}agentId=${encodeURIComponent(context.agentId)}`, {
      ...init,
      signal: context.signal
    });
  }

  function targetDirty(target: SaveTarget) {
    return target === "groupReply" ? isGroupReplyDirty() : isDirty(target);
  }

  function stateKey(target: SaveTarget): ConfigSectionKey {
    return target === "groupReply" ? "orchestrator" : target;
  }

  function isDirty(key: ConfigSectionKey) {
    return !same(drafts[key], baselines[key]);
  }

  function isGroupReplyDirty() {
    return isDirty("orchestrator")
      || drafts.onebot.autoReplyUserGroup !== baselines.onebot.autoReplyUserGroup;
  }

  function isOneBotSettingsDirty() {
    return isReplyBehaviorDirty() || isOneBotConnectionDirty();
  }

  function isReplyBehaviorDirty() {
    return drafts.onebot.autoReplyPrivate !== baselines.onebot.autoReplyPrivate
      || drafts.onebot.autoReplyBotGroup !== baselines.onebot.autoReplyBotGroup
      || !same(drafts.onebot.mentionNames, baselines.onebot.mentionNames)
      || !same(drafts.onebot.commandPrefixes, baselines.onebot.commandPrefixes);
  }

  function isNoReplyPokeDirty() {
    return drafts.bot.pokeOnNoReply !== baselines.bot.pokeOnNoReply;
  }

  function isOneBotConnectionDirty() {
    return drafts.onebot.reverseWsPath !== baselines.onebot.reverseWsPath
      || drafts.onebot.accessTokenEnv !== baselines.onebot.accessTokenEnv;
  }

  return {
    envelope: readonly(envelope),
    drafts,
    state,
    loading: readonly(loading),
    load,
    commit,
    flush,
    cancel,
    isDirty,
    isGroupReplyDirty,
    isOneBotSettingsDirty,
    isReplyBehaviorDirty,
    isNoReplyPokeDirty,
    isOneBotConnectionDirty,
    agentId: () => contextAgentId
  };
}

function valuesFromConfig(config: AppConfig): SectionDrafts {
  return {
    server: clone(config.server),
    persona: { agentWorkspace: config.persona.agentWorkspace },
    providers: clone(config.providers),
    broadcastStorm: clone(config.broadcastStorm),
    normalReply: clone(config.normalReply ?? emptyConfig.normalReply),
    bot: {
      adminQq: config.bot.adminQq,
      adminName: config.bot.adminName,
      replyDebounceMs: config.bot.replyDebounceMs ?? emptyConfig.bot.replyDebounceMs,
      pokeOnNoReply: config.bot.pokeOnNoReply,
      quoteGroupReplies: config.bot.quoteGroupReplies,
      quoteGroupReplyExcludedUserIds: [...(config.bot.quoteGroupReplyExcludedUserIds ?? [])],
      contextMessageLimit: config.bot.contextMessageLimit,
      emojiSendSize: config.bot.emojiSendSize ?? emptyConfig.bot.emojiSendSize,
      emojiSendSeparately: config.bot.emojiSendSeparately === true
    },
    tone: {
      ...clone(emptyConfig.bot.tone),
      ...clone(config.bot.tone ?? {})
    },
    memory: clone(config.bot.memory),
    orchestrator: {
      ...clone(config.bot.orchestrator),
      groupThreadModel: config.bot.orchestrator.groupThreadModel?.trim() || emptyConfig.bot.orchestrator.groupThreadModel
    },
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

function same(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function idle() {
  return { kind: "idle" as const, message: "" };
}

function isAbort(error: unknown) {
  return error instanceof DOMException && error.name === "AbortError";
}
