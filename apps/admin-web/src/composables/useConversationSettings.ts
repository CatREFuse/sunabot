import { computed, readonly, shallowReadonly, shallowRef, toValue, type MaybeRefOrGetter } from "vue";
import type { ConversationRecord, ToolName } from "../types";
import { activeAgentId, activeAgentIdState } from "./agentScope";
import { apiRequest } from "./useAdminApi";
import { useConversationTools } from "./useConversationTools";

const WEB_CHAT_CONVERSATION_ID = "web:admin";

export function useConversationSettings(conversationId: MaybeRefOrGetter<string>) {
  const toolPolicy = useConversationTools(conversationId);
  const conversation = shallowRef<ConversationRecord | null>(null);
  const replyEnabled = shallowRef(true);
  const orchestratorEnabled = shallowRef(true);
  const disabledTools = shallowRef<ToolName[]>([]);
  const loading = shallowRef(false);
  const behaviorSaving = shallowRef(false);
  const loadError = shallowRef("");
  const behaviorError = shallowRef("");
  const behaviorMessage = shallowRef("");
  const toolMessage = shallowRef("");
  const toolAccessError = shallowRef("");
  const toolDraftDirty = shallowRef(false);
  let requestId = 0;
  let behaviorSaveRequestId = 0;
  let loadedAgentId = "";
  const toolsReadyContext = shallowRef<{ conversationId: string; agentId: string } | null>(null);

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
  const toolsDirty = computed(() => toolDraftDirty.value);
  const toolError = computed(() => toolAccessError.value || toolPolicy.error.value);

  async function load(force = false) {
    const id = toValue(conversationId).trim();
    if (!id) return false;
    const agentId = activeAgentId();
    const activeRequest = ++requestId;
    toolsReadyContext.value = null;
    toolDraftDirty.value = false;
    const switchingContext = conversation.value?.id !== id || (loadedAgentId && loadedAgentId !== agentId);
    if (switchingContext) {
      behaviorSaveRequestId += 1;
      behaviorSaving.value = false;
      toolPolicy.dispose();
      conversation.value = null;
      loadedAgentId = "";
      replyEnabled.value = true;
      orchestratorEnabled.value = true;
      disabledTools.value = [];
    }
    loading.value = true;
    loadError.value = "";
    behaviorError.value = "";
    behaviorMessage.value = "";
    toolMessage.value = "";
    toolAccessError.value = "";
    try {
      const nextConversation = id === WEB_CHAT_CONVERSATION_ID
        ? webChatConversation()
        : await loadConversation(id);
      if (activeRequest !== requestId || id !== toValue(conversationId).trim()) return false;
      if (agentId !== activeAgentId()) throw new Error("Agent 已切换，请刷新页面");
      conversation.value = nextConversation;
      loadedAgentId = agentId;
      replyEnabled.value = nextConversation.replyEnabled !== false;
      orchestratorEnabled.value = nextConversation.orchestratorEnabled !== false;
      const toolsLoaded = await toolPolicy.load(force);
      if (activeRequest !== requestId || id !== toValue(conversationId).trim()) return false;
      if (agentId !== activeAgentId()) throw new Error("Agent 已切换，请刷新页面");
      if (toolsLoaded) {
        disabledTools.value = [...toolPolicy.disabledTools.value];
        toolsReadyContext.value = { conversationId: id, agentId };
        toolAccessError.value = "";
      }
      return toolsLoaded;
    } catch (caught) {
      if (activeRequest === requestId) {
        conversation.value = null;
        loadedAgentId = "";
        loadError.value = caught instanceof Error ? caught.message : "会话设置读取失败";
      }
      return false;
    } finally {
      if (activeRequest === requestId) loading.value = false;
    }
  }

  function setReplyEnabled(value: boolean) {
    replyEnabled.value = value;
    behaviorError.value = "";
    behaviorMessage.value = "";
  }

  function setOrchestratorEnabled(value: boolean) {
    orchestratorEnabled.value = value;
    behaviorError.value = "";
    behaviorMessage.value = "";
  }

  async function saveBehavior() {
    const current = conversation.value;
    const id = toValue(conversationId).trim();
    const agentId = activeAgentId();
    if (loadedAgentId !== agentId) {
      behaviorError.value = "Agent 已切换，请刷新页面";
      return false;
    }
    if (!current || current.id !== id || !supportsBehavior.value || behaviorSaving.value) return false;
    if (!behaviorDirty.value) return true;
    const activeRequest = ++behaviorSaveRequestId;
    const activeLoadRequest = requestId;
    behaviorSaving.value = true;
    behaviorError.value = "";
    behaviorMessage.value = "";
    try {
      const payload = await apiRequest<{ conversation: ConversationRecord }>("/api/conversations/reply", {
        method: "PUT",
        body: JSON.stringify({
          id: current.id,
          scope: current.scope,
          title: current.title,
          userId: current.userId,
          groupId: current.groupId,
          replyEnabled: replyEnabled.value,
          ...(supportsOrchestrator.value ? { orchestratorEnabled: orchestratorEnabled.value } : {})
        })
      });
      if (
        activeRequest === behaviorSaveRequestId
        && activeLoadRequest === requestId
        && id === toValue(conversationId).trim()
        && agentId === activeAgentId()
        && loadedAgentId === agentId
        && conversation.value?.id === id
      ) {
        conversation.value = payload.conversation;
        replyEnabled.value = payload.conversation.replyEnabled !== false;
        orchestratorEnabled.value = payload.conversation.orchestratorEnabled !== false;
        behaviorMessage.value = "已保存";
      }
      return true;
    } catch (caught) {
      if (
        activeRequest === behaviorSaveRequestId
        && activeLoadRequest === requestId
        && id === toValue(conversationId).trim()
        && agentId === activeAgentId()
        && loadedAgentId === agentId
        && conversation.value?.id === id
      ) {
        behaviorError.value = caught instanceof Error ? caught.message : "回复设置保存失败";
      }
      return false;
    } finally {
      if (activeRequest === behaviorSaveRequestId) behaviorSaving.value = false;
    }
  }

  function discardBehavior() {
    const current = conversation.value;
    if (!current) return;
    replyEnabled.value = current.replyEnabled !== false;
    orchestratorEnabled.value = current.orchestratorEnabled !== false;
    behaviorError.value = "";
    behaviorMessage.value = "";
  }

  function setToolEnabled(name: ToolName, enabled: boolean) {
    if (!toolsReady.value) return;
    const next = new Set(disabledTools.value);
    if (enabled) next.delete(name);
    else next.add(name);
    disabledTools.value = [...next];
    toolDraftDirty.value = !sameToolSet(disabledTools.value, toolPolicy.disabledTools.value);
    toolMessage.value = "";
    toolAccessError.value = "";
  }

  async function saveTools() {
    const id = toValue(conversationId).trim();
    const agentId = activeAgentId();
    const activeLoadRequest = requestId;
    if (loadedAgentId !== agentId) {
      toolAccessError.value = "Agent 已切换，请刷新页面";
      return false;
    }
    if (!toolsReady.value) {
      toolAccessError.value = "工具权限仍在加载";
      return false;
    }
    if (!conversation.value || conversation.value.id !== id) return false;
    if (!toolsDirty.value) return true;
    toolMessage.value = "";
    if (!await toolPolicy.save(disabledTools.value)) return false;
    if (
      activeLoadRequest === requestId
      && id === toValue(conversationId).trim()
      && agentId === activeAgentId()
      && loadedAgentId === agentId
      && conversation.value?.id === id
    ) {
      disabledTools.value = [...toolPolicy.disabledTools.value];
      toolDraftDirty.value = false;
      toolMessage.value = "已保存";
    }
    return true;
  }

  function discardTools() {
    disabledTools.value = [...toolPolicy.disabledTools.value];
    toolDraftDirty.value = false;
    toolMessage.value = "";
    toolAccessError.value = "";
  }

  function dispose() {
    requestId += 1;
    behaviorSaveRequestId += 1;
    behaviorSaving.value = false;
    loadedAgentId = "";
    toolsReadyContext.value = null;
    toolDraftDirty.value = false;
    toolPolicy.dispose();
  }

  return {
    conversation: shallowReadonly(conversation),
    tools,
    toolsReady,
    replyEnabled: readonly(replyEnabled),
    orchestratorEnabled: readonly(orchestratorEnabled),
    disabledTools: readonly(disabledTools),
    loading: readonly(loading),
    behaviorSaving: readonly(behaviorSaving),
    toolSaving: toolPolicy.saving,
    loadError: readonly(loadError),
    behaviorError: readonly(behaviorError),
    toolError,
    behaviorMessage: readonly(behaviorMessage),
    toolMessage: readonly(toolMessage),
    isWebChat,
    supportsBehavior,
    supportsOrchestrator,
    behaviorDirty,
    toolsDirty,
    load,
    setReplyEnabled,
    setOrchestratorEnabled,
    saveBehavior,
    discardBehavior,
    setToolEnabled,
    saveTools,
    discardTools,
    dispose
  };
}

async function loadConversation(id: string) {
  const payload = await apiRequest<{ conversations: ConversationRecord[] }>("/api/conversations");
  const conversation = payload.conversations.find((item) => item.id === id);
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
