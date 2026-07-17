import { readonly, shallowRef, toValue, type MaybeRefOrGetter } from "vue";
import type { ToolName } from "../types";
import { activeAgentId } from "./agentScope";
import { apiRequest } from "./useAdminApi";
import { useToolCatalog } from "./useToolCatalog";

interface ConversationToolPolicy {
  conversationId: string;
  disabledTools: ToolName[];
}

interface ConversationToolRequestOptions {
  agentId?: string;
  signal?: AbortSignal;
}

export function useConversationTools(conversationId: MaybeRefOrGetter<string>) {
  const catalog = useToolCatalog();
  const disabledTools = shallowRef<ToolName[]>([]);
  const loading = shallowRef(false);
  const saving = shallowRef(false);
  const error = shallowRef("");
  let requestId = 0;
  let saveRequestId = 0;

  async function load(force = false, options: ConversationToolRequestOptions = {}) {
    const id = toValue(conversationId).trim();
    if (!id) return false;
    const agentId = options.agentId ?? activeAgentId();
    const activeRequest = ++requestId;
    loading.value = true;
    error.value = "";
    try {
      const [, policy] = await Promise.all([
        catalog.load(force),
        apiRequest<ConversationToolPolicy>(toolPolicyPath(id, options.agentId), { signal: options.signal })
      ]);
      if (activeRequest !== requestId || id !== toValue(conversationId).trim() || agentId !== activeAgentId()) return false;
      if (!catalog.loaded.value) {
        error.value = catalog.error.value || "工具目录读取失败";
        return false;
      }
      disabledTools.value = [...policy.disabledTools];
      return true;
    } catch (caught) {
      if (isAbort(caught)) return false;
      if (activeRequest === requestId && id === toValue(conversationId).trim() && agentId === activeAgentId()) {
        error.value = caught instanceof Error ? caught.message : "会话工具读取失败";
      }
      return false;
    } finally {
      if (activeRequest === requestId) loading.value = false;
    }
  }

  async function save(nextDisabledTools: readonly ToolName[], options: ConversationToolRequestOptions = {}) {
    const id = toValue(conversationId).trim();
    if (!id || saving.value) return false;
    const agentId = options.agentId ?? activeAgentId();
    const activeRequest = ++saveRequestId;
    saving.value = true;
    error.value = "";
    try {
      const policy = await apiRequest<ConversationToolPolicy>(
        toolPolicyPath(id, options.agentId),
        {
          method: "PUT",
          body: JSON.stringify({ disabledTools: [...nextDisabledTools] }),
          signal: options.signal
        }
      );
      if (activeRequest === saveRequestId && id === toValue(conversationId).trim() && agentId === activeAgentId()) {
        disabledTools.value = [...policy.disabledTools];
      }
      return true;
    } catch (caught) {
      if (isAbort(caught)) return false;
      if (activeRequest === saveRequestId && id === toValue(conversationId).trim() && agentId === activeAgentId()) {
        error.value = caught instanceof Error ? caught.message : "会话工具保存失败";
      }
      return false;
    } finally {
      if (activeRequest === saveRequestId) saving.value = false;
    }
  }

  function dispose() {
    requestId += 1;
    saveRequestId += 1;
    loading.value = false;
    saving.value = false;
  }

  return {
    tools: catalog.tools,
    catalogLoading: catalog.loading,
    disabledTools: readonly(disabledTools),
    loading: readonly(loading),
    saving: readonly(saving),
    error: readonly(error),
    load,
    save,
    dispose
  };
}

function toolPolicyPath(conversationId: string, agentId?: string) {
  const path = `/api/conversations/${encodeURIComponent(conversationId)}/tools`;
  return agentId ? `${path}?agentId=${encodeURIComponent(agentId)}` : path;
}

function isAbort(error: unknown) {
  return error instanceof DOMException && error.name === "AbortError";
}
