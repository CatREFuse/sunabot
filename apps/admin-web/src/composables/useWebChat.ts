import { computed, onBeforeUnmount, onMounted, shallowReadonly, shallowRef } from "vue";
import type { ConversationMessagePage, ConversationMessageRecord } from "../types";
import { apiRequest } from "./useAdminApi";

interface LoadOptions {
  quiet?: boolean;
  clearError?: boolean;
}

export function useWebChat() {
  const messages = shallowRef<ConversationMessageRecord[]>([]);
  const draft = shallowRef("");
  const loading = shallowRef(false);
  const sending = shallowRef(false);
  const error = shallowRef("");
  const scrollRevision = shallowRef(0);
  const sendable = computed(() => {
    const text = draft.value.trim();
    return text.length > 0 && text.length <= 16_000 && !sending.value;
  });
  let loadController: AbortController | undefined;
  let loadTask: Promise<void> | undefined;
  let sendController: AbortController | undefined;
  let pollTimer: number | undefined;
  let disposed = false;

  onMounted(() => void load());
  onBeforeUnmount(dispose);

  function load(options: LoadOptions = {}) {
    if (loadTask) return loadTask;
    const controller = new AbortController();
    loadController = controller;
    const task = (async () => {
      if (!options.quiet) loading.value = true;
      try {
        const page = await apiRequest<ConversationMessagePage>("/api/web-chat/messages", {
          signal: controller.signal
        });
        if (!disposed && loadController === controller) {
          applyPage(page);
          if (options.clearError !== false) error.value = "";
        }
      } catch (caught) {
        if (isAbort(caught) || disposed) return;
        error.value = caught instanceof Error ? caught.message : "会话读取失败";
      } finally {
        if (loadController === controller) {
          loadController = undefined;
          loading.value = false;
        }
      }
    })();
    const currentTask = task.finally(() => {
      if (loadTask === currentTask) loadTask = undefined;
    });
    loadTask = currentTask;
    return loadTask;
  }

  async function send() {
    const text = draft.value.trim();
    if (!text || text.length > 16_000 || sending.value) return;

    const controller = new AbortController();
    sendController = controller;
    draft.value = "";
    sending.value = true;
    error.value = "";
    startPolling();
    try {
      const page = await apiRequest<ConversationMessagePage>("/api/web-chat/messages", {
        method: "POST",
        body: JSON.stringify({ text }),
        signal: controller.signal
      });
      if (!disposed && sendController === controller) applyPage(page);
    } catch (caught) {
      if (!isAbort(caught) && !disposed) {
        if (!draft.value.trim()) draft.value = text;
        error.value = caught instanceof Error ? caught.message : "发送失败";
      }
    } finally {
      if (sendController === controller) {
        sendController = undefined;
        sending.value = false;
      }
      stopPolling();
      if (!disposed) {
        await loadTask;
        await load({ quiet: true, clearError: false });
      }
    }
  }

  function requestScroll() {
    scrollRevision.value += 1;
  }

  function applyPage(page: ConversationMessagePage) {
    messages.value = page.messages;
    requestScroll();
  }

  function startPolling() {
    stopPolling();
    pollTimer = window.setInterval(() => {
      void load({ quiet: true, clearError: false });
    }, 900);
  }

  function stopPolling() {
    if (pollTimer != null) window.clearInterval(pollTimer);
    pollTimer = undefined;
  }

  function dispose() {
    disposed = true;
    loadController?.abort();
    loadTask = undefined;
    sendController?.abort();
    stopPolling();
  }

  return {
    messages: shallowReadonly(messages),
    draft,
    loading: shallowReadonly(loading),
    sending: shallowReadonly(sending),
    error: shallowReadonly(error),
    scrollRevision: shallowReadonly(scrollRevision),
    sendable,
    load,
    send,
    requestScroll,
    dispose
  };
}

function isAbort(value: unknown) {
  return value instanceof DOMException && value.name === "AbortError";
}
