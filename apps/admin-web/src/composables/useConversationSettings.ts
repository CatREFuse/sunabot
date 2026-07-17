import {
  computed,
  getCurrentScope,
  onScopeDispose,
  readonly,
  shallowReadonly,
  shallowRef,
  toValue,
  type MaybeRefOrGetter
} from "vue";
import type { ConversationRecord, ToolName } from "../types";
import { activeAgentId, activeAgentIdState } from "./agentScope";
import { apiRequest } from "./useAdminApi";
import { useConversationTools } from "./useConversationTools";

type SyncTarget = "behavior" | "tools";
type SyncKind = "idle" | "waiting" | "saving" | "saved" | "error";
interface SyncState { kind: SyncKind; message: string }
interface RequestContext { generation: number; conversationId: string; agentId: string; signal: AbortSignal }

const WEB_CHAT_CONVERSATION_ID = "web:admin";
const AUTO_SAVE_DELAY_MS = 350;

export function useConversationSettings(conversationId: MaybeRefOrGetter<string>) {
  const toolPolicy = useConversationTools(conversationId);
  const conversation = shallowRef<ConversationRecord | null>(null);
  const replyEnabled = shallowRef(true);
  const orchestratorEnabled = shallowRef(true);
  const disabledTools = shallowRef<ToolName[]>([]);
  const baselineDisabledTools = shallowRef<ToolName[]>([]);
  const loading = shallowRef(false);
  const loadError = shallowRef("");
  const toolAccessError = shallowRef("");
  const behaviorState = shallowRef<SyncState>(idle());
  const toolState = shallowRef<SyncState>(idle());
  const toolsReadyContext = shallowRef<{ conversationId: string; agentId: string } | null>(null);
  const pendingTargets = new Set<SyncTarget>();
  let generation = 0;
  let contextConversationId = "";
  let contextAgentId = "";
  let contextController = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let drainPromise: Promise<void> | undefined;

  const isWebChat = computed(() => toValue(conversationId).trim() === WEB_CHAT_CONVERSATION_ID);
  const supportsBehavior = computed(() => Boolean(conversation.value) && !isWebChat.value);
  const supportsOrchestrator = computed(() => conversation.value?.scope === "user_group");
  const behaviorDirty = computed(() => {
    const current = conversation.value;
    if (!current || !supportsBehavior.value) return false;
    return replyEnabled.value !== (current.replyEnabled !== false)
      || (supportsOrchestrator.value && orchestratorEnabled.value !== (current.orchestratorEnabled !== false));
  });
  const toolsReady = computed(() => {
    const id = toValue(conversationId).trim();
    const context = toolsReadyContext.value;
    return Boolean(id)
      && context?.conversationId === id
      && context.agentId === activeAgentIdState.value
      && conversation.value?.id === id;
  });
  const tools = computed(() => toolsReady.value ? toolPolicy.tools.value : []);
  const toolsDirty = computed(() => !sameToolSet(disabledTools.value, baselineDisabledTools.value));
  const toolError = computed(() => toolAccessError.value || toolPolicy.error.value);
  const behaviorSyncing = computed(() => behaviorState.value.kind === "saving");

  if (getCurrentScope()) onScopeDispose(cancel);

  async function load(force = false) {
    const id = toValue(conversationId).trim();
    if (!id) return false;
    beginContext(id, activeAgentId());
    const context = currentContext();
    resetViewState();
    loading.value = true;
    try {
      const nextConversation = id === WEB_CHAT_CONVERSATION_ID
        ? webChatConversation()
        : await loadConversation(context);
      if (!isCurrent(context)) return false;
      conversation.value = nextConversation;
      replyEnabled.value = nextConversation.replyEnabled !== false;
      orchestratorEnabled.value = nextConversation.orchestratorEnabled !== false;
      const toolsLoaded = await toolPolicy.load(force, {
        agentId: context.agentId,
        signal: context.signal
      });
      if (!isCurrent(context)) return false;
      if (!toolsLoaded) {
        toolAccessError.value = toolPolicy.error.value || "工具权限读取失败";
        toolState.value = { kind: "error", message: toolAccessError.value };
        return false;
      }
      baselineDisabledTools.value = [...toolPolicy.disabledTools.value];
      disabledTools.value = [...baselineDisabledTools.value];
      toolsReadyContext.value = { conversationId: id, agentId: context.agentId };
      return true;
    } catch (caught) {
      if (isAbort(caught) || !isCurrent(context)) return false;
      conversation.value = null;
      loadError.value = caught instanceof Error ? caught.message : "会话设置读取失败";
      return false;
    } finally {
      if (isCurrent(context)) loading.value = false;
    }
  }

  function setReplyEnabled(value: boolean) {
    replyEnabled.value = value;
    schedule("behavior");
  }

  function setOrchestratorEnabled(value: boolean) {
    orchestratorEnabled.value = value;
    schedule("behavior");
  }

  function setToolEnabled(name: ToolName, enabled: boolean) {
    if (!toolsReady.value) return;
    const next = new Set(disabledTools.value);
    if (enabled) next.delete(name);
    else next.add(name);
    disabledTools.value = [...next];
    toolAccessError.value = "";
    schedule("tools");
  }

  function schedule(target: SyncTarget) {
    if (!targetDirty(target)) {
      pendingTargets.delete(target);
      if (stateFor(target).value.kind !== "saving") stateFor(target).value = idle();
      if (pendingTargets.size === 0 && timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      return;
    }
    pendingTargets.add(target);
    const state = stateFor(target);
    state.value = state.value.kind === "saving"
      ? { kind: "saving", message: "正在同步后续修改" }
      : { kind: "waiting", message: "等待同步" };
    if (drainPromise) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      void startDrain();
    }, AUTO_SAVE_DELAY_MS);
  }

  function startDrain() {
    if (drainPromise) return drainPromise;
    const context = currentContext();
    const running = drain(context).finally(() => {
      if (drainPromise === running) drainPromise = undefined;
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
        if (stateFor(target).value.kind === "waiting") stateFor(target).value = idle();
        continue;
      }
      if (target === "behavior") await syncBehavior(context);
      else await syncTools(context);
    }
  }

  async function syncBehavior(context: RequestContext) {
    const current = conversation.value;
    if (!current || current.id !== context.conversationId || !supportsBehavior.value || !isCurrent(context)) return;
    const submitted = {
      replyEnabled: replyEnabled.value,
      orchestratorEnabled: orchestratorEnabled.value
    };
    behaviorState.value = { kind: "saving", message: "正在同步" };
    try {
      const payload = await request<{ conversation: ConversationRecord }>(context, "/api/conversations/reply", {
        method: "PUT",
        body: JSON.stringify({
          id: current.id,
          scope: current.scope,
          title: current.title,
          userId: current.userId,
          groupId: current.groupId,
          replyEnabled: submitted.replyEnabled,
          ...(supportsOrchestrator.value ? { orchestratorEnabled: submitted.orchestratorEnabled } : {})
        })
      });
      if (!isCurrent(context) || conversation.value?.id !== context.conversationId) return;
      const currentReply = replyEnabled.value;
      const currentOrchestrator = orchestratorEnabled.value;
      conversation.value = payload.conversation;
      if (currentReply === submitted.replyEnabled) replyEnabled.value = payload.conversation.replyEnabled !== false;
      if (currentOrchestrator === submitted.orchestratorEnabled) {
        orchestratorEnabled.value = payload.conversation.orchestratorEnabled !== false;
      }
      finishTarget("behavior");
    } catch (caught) {
      if (isAbort(caught) || !isCurrent(context)) return;
      behaviorState.value = {
        kind: "error",
        message: caught instanceof Error ? caught.message : "回复设置同步失败"
      };
    }
  }

  async function syncTools(context: RequestContext) {
    if (!toolsReady.value || !isCurrent(context)) return;
    const submitted = [...disabledTools.value];
    toolState.value = { kind: "saving", message: "正在同步" };
    const saved = await toolPolicy.save(submitted, {
      agentId: context.agentId,
      signal: context.signal
    });
    if (!isCurrent(context) || conversation.value?.id !== context.conversationId) return;
    if (!saved) {
      toolAccessError.value = toolPolicy.error.value || "工具权限同步失败";
      toolState.value = { kind: "error", message: toolAccessError.value };
      return;
    }
    const currentDraft = [...disabledTools.value];
    baselineDisabledTools.value = [...toolPolicy.disabledTools.value];
    if (sameToolSet(currentDraft, submitted)) disabledTools.value = [...baselineDisabledTools.value];
    toolAccessError.value = "";
    finishTarget("tools");
  }

  function finishTarget(target: SyncTarget) {
    const state = stateFor(target);
    if (targetDirty(target)) {
      pendingTargets.add(target);
      state.value = { kind: "waiting", message: "正在同步后续修改" };
      return;
    }
    state.value = { kind: "saved", message: "已同步" };
  }

  async function flush() {
    const context = currentContext();
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
    if (behaviorDirty.value) pendingTargets.add("behavior");
    if (toolsDirty.value) pendingTargets.add("tools");
    while (pendingTargets.size > 0 || drainPromise) {
      await startDrain();
      if (!isCurrent(context)) return false;
    }
    return !behaviorDirty.value && !toolsDirty.value;
  }

  function cancel() {
    generation += 1;
    pendingTargets.clear();
    if (timer) clearTimeout(timer);
    timer = undefined;
    contextController.abort();
    contextController = new AbortController();
    contextConversationId = "";
    contextAgentId = "";
    drainPromise = undefined;
    toolsReadyContext.value = null;
    loading.value = false;
    toolPolicy.dispose();
  }

  function dispose() {
    cancel();
  }

  function beginContext(id: string, agentId: string) {
    cancel();
    contextConversationId = id;
    contextAgentId = agentId;
  }

  function currentContext(): RequestContext {
    return {
      generation,
      conversationId: contextConversationId,
      agentId: contextAgentId,
      signal: contextController.signal
    };
  }

  function isCurrent(context: RequestContext) {
    return context.generation === generation
      && context.conversationId === contextConversationId
      && context.agentId === contextAgentId
      && context.agentId === activeAgentId()
      && context.conversationId === toValue(conversationId).trim()
      && !context.signal.aborted;
  }

  function request<T>(context: RequestContext, path: string, init: RequestInit = {}) {
    const separator = path.includes("?") ? "&" : "?";
    return apiRequest<T>(`${path}${separator}agentId=${encodeURIComponent(context.agentId)}`, {
      ...init,
      signal: context.signal
    });
  }

  function targetDirty(target: SyncTarget) {
    return target === "behavior" ? behaviorDirty.value : toolsDirty.value;
  }

  function stateFor(target: SyncTarget) {
    return target === "behavior" ? behaviorState : toolState;
  }

  function resetViewState() {
    conversation.value = null;
    replyEnabled.value = true;
    orchestratorEnabled.value = true;
    disabledTools.value = [];
    baselineDisabledTools.value = [];
    toolsReadyContext.value = null;
    loadError.value = "";
    toolAccessError.value = "";
    behaviorState.value = idle();
    toolState.value = idle();
  }

  return {
    conversation: shallowReadonly(conversation),
    tools,
    toolsReady,
    replyEnabled: readonly(replyEnabled),
    orchestratorEnabled: readonly(orchestratorEnabled),
    disabledTools: readonly(disabledTools),
    loading: readonly(loading),
    behaviorSyncing,
    loadError: readonly(loadError),
    toolError,
    behaviorState: readonly(behaviorState),
    toolState: readonly(toolState),
    isWebChat,
    supportsBehavior,
    supportsOrchestrator,
    behaviorDirty,
    toolsDirty,
    load,
    flush,
    cancel,
    setReplyEnabled,
    setOrchestratorEnabled,
    setToolEnabled,
    dispose
  };
}

async function loadConversation(context: RequestContext) {
  const payload = await apiRequest<{ conversations: ConversationRecord[] }>(
    `/api/conversations?agentId=${encodeURIComponent(context.agentId)}`,
    { signal: context.signal }
  );
  const conversation = payload.conversations.find((item) => item.id === context.conversationId);
  if (!conversation) throw new Error("会话不存在");
  return conversation;
}

function webChatConversation(): ConversationRecord {
  return {
    id: WEB_CHAT_CONVERSATION_ID,
    scope: "private",
    title: "Web Chat",
    userId: 0,
    messageCount: 0,
    lastAt: "",
    lastText: "",
    messages: []
  };
}

function sameToolSet(left: readonly ToolName[], right: readonly ToolName[]) {
  return left.length === right.length && left.every((name) => right.includes(name));
}

function idle(): SyncState {
  return { kind: "idle", message: "" };
}

function isAbort(error: unknown) {
  return error instanceof DOMException && error.name === "AbortError";
}
