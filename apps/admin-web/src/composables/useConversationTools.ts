import { readonly, shallowRef, toValue, type MaybeRefOrGetter } from "vue";
import type { ToolName } from "../types";
import { apiRequest } from "./useAdminApi";
import { useToolCatalog } from "./useToolCatalog";

interface ConversationToolPolicy {
  conversationId: string;
  disabledTools: ToolName[];
}

export function useConversationTools(conversationId: MaybeRefOrGetter<string>) {
  const catalog = useToolCatalog();
  const disabledTools = shallowRef<ToolName[]>([]);
  const loading = shallowRef(false);
  const saving = shallowRef(false);
  const error = shallowRef("");
  let requestId = 0;

  async function load(force = false) {
    const id = toValue(conversationId).trim();
    if (!id) return false;
    const activeRequest = ++requestId;
    loading.value = true;
    error.value = "";
    try {
      const [, policy] = await Promise.all([
        catalog.load(force),
        apiRequest<ConversationToolPolicy>(`/api/conversations/${encodeURIComponent(id)}/tools`)
      ]);
      if (activeRequest !== requestId || id !== toValue(conversationId).trim()) return false;
      if (!catalog.loaded.value) {
        error.value = catalog.error.value || "工具目录读取失败";
        return false;
      }
      disabledTools.value = [...policy.disabledTools];
      return true;
    } catch (caught) {
      if (activeRequest === requestId) {
        error.value = caught instanceof Error ? caught.message : "会话工具读取失败";
      }
      return false;
    } finally {
      if (activeRequest === requestId) loading.value = false;
    }
  }

  async function save(nextDisabledTools: readonly ToolName[]) {
    const id = toValue(conversationId).trim();
    if (!id || saving.value) return false;
    saving.value = true;
    error.value = "";
    try {
      const policy = await apiRequest<ConversationToolPolicy>(
        `/api/conversations/${encodeURIComponent(id)}/tools`,
        {
          method: "PUT",
          body: JSON.stringify({ disabledTools: [...nextDisabledTools] })
        }
      );
      if (id === toValue(conversationId).trim()) disabledTools.value = [...policy.disabledTools];
      return true;
    } catch (caught) {
      error.value = caught instanceof Error ? caught.message : "会话工具保存失败";
      return false;
    } finally {
      saving.value = false;
    }
  }

  function dispose() {
    requestId += 1;
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
