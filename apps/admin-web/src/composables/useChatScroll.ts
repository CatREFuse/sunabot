import { nextTick, onBeforeUnmount, shallowRef, useTemplateRef, watch, type Ref } from "vue";

const BOTTOM_THRESHOLD_PX = 48;

interface ChatScrollOptions {
  conversationId: Readonly<Ref<string>>;
  messageIds: Readonly<Ref<readonly string[]>>;
}

export function useChatScroll(options: ChatScrollOptions) {
  const viewport = useTemplateRef<HTMLElement>("messageViewport");
  const content = useTemplateRef<HTMLElement>("messageContent");
  const stickToBottom = shallowRef(true);
  let userScrollTimer: number | undefined;

  watch(options.conversationId, () => {
    stickToBottom.value = true;
    void nextTick(scrollToBottom);
  }, { immediate: true });

  watch(options.messageIds, (current, previous = []) => {
    const element = viewport.value;
    if (!element || !current.length) return;
    const previousTop = element.scrollTop;
    const previousHeight = element.scrollHeight;
    const prepended = hasPrependedMessages(current, previous);
    const shouldFollow = stickToBottom.value || isNearBottom(element);

    void nextTick(() => {
      const nextElement = viewport.value;
      if (!nextElement) return;
      if (prepended) {
        nextElement.scrollTop = previousTop + (nextElement.scrollHeight - previousHeight);
      } else if (shouldFollow) {
        scrollToBottom();
      }
    });
  }, { flush: "pre" });

  watch(content, (element, _previous, onCleanup) => {
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (stickToBottom.value) scrollToBottom();
    });
    observer.observe(element);
    onCleanup(() => observer.disconnect());
  }, { flush: "post" });

  function handleUserScroll() {
    stickToBottom.value = false;
    if (userScrollTimer != null) window.clearTimeout(userScrollTimer);
    userScrollTimer = window.setTimeout(() => {
      if (viewport.value) stickToBottom.value = isNearBottom(viewport.value);
    }, 120);
  }

  function handleContentLoad() {
    if (stickToBottom.value) void nextTick(scrollToBottom);
  }

  function scrollToBottom() {
    const element = viewport.value;
    if (element) element.scrollTop = element.scrollHeight;
  }

  onBeforeUnmount(() => {
    if (userScrollTimer != null) window.clearTimeout(userScrollTimer);
  });

  return { handleUserScroll, handleContentLoad };
}

function isNearBottom(element: HTMLElement) {
  return element.scrollHeight - element.scrollTop - element.clientHeight <= BOTTOM_THRESHOLD_PX;
}

function hasPrependedMessages(current: readonly string[], previous: readonly string[]) {
  if (!previous.length || current.length <= previous.length) return false;
  const previousFirst = previous[0];
  return Boolean(previousFirst) && current[0] !== previousFirst && current.includes(previousFirst!) && current.at(-1) === previous.at(-1);
}
