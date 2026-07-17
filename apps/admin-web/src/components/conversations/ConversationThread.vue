<script setup lang="ts">
import { computed, shallowRef, watch } from "vue";
import { useChatScroll } from "../../composables/useChatScroll";
import type { ConversationLogEntry, ConversationMessageRecord, ConversationRecord, ConversationStatsPayload } from "../../types";
import DialogOverlay from "../ui/DialogOverlay.vue";
import ConversationMessageBubble from "./ConversationMessageBubble.vue";
import ConversationQuickControls from "./ConversationQuickControls.vue";
import ConversationSidePanel from "./ConversationSidePanel.vue";
import RequestLogList from "../logs/RequestLogList.vue";

const props = withDefaults(defineProps<{
  conversation: ConversationRecord | null;
  messages: readonly ConversationMessageRecord[];
  memberNames?: Readonly<Record<string, string>>;
  logs: readonly ConversationLogEntry[];
  stats?: ConversationStatsPayload | null;
  hasMore: boolean;
  loadingMessages: boolean;
  loadingLogs: boolean;
  error: string;
}>(), {
  memberNames: () => ({}),
  stats: null
});
const emit = defineEmits<{
  back: [];
  refresh: [];
  older: [];
  logs: [runId?: string];
  reply: [enabled: boolean];
  orchestrator: [enabled: boolean];
}>();
const logsOpen = shallowRef(false);
const activeLogRunId = shallowRef<string | undefined>();
const activePanel = defineModel<"settings" | "usage" | null>("sidePanel", { default: null });
const conversationId = computed(() => props.conversation?.id ?? "");
const messageIds = computed(() => props.messages.map((message) => message.id));
const { handleUserScroll, handleContentLoad } = useChatScroll({ conversationId, messageIds });

watch(conversationId, () => {
  activePanel.value = null;
  logsOpen.value = false;
});

function openLogs(runId?: string) {
  activeLogRunId.value = runId;
  logsOpen.value = true;
  emit("logs", runId);
}
function refreshLogs() {
  emit("logs", activeLogRunId.value);
}
</script>

<template>
  <section class="flex h-full min-h-0 min-w-0 flex-col bg-page">
    <header class="flex min-h-20 items-center gap-3 border-b border-line px-4 md:px-6">
      <button class="icon-btn lg:hidden" type="button" aria-label="返回会话列表" @click="emit('back')"><i class="bx bx-left-arrow-alt text-xl" aria-hidden="true"></i></button>
      <div class="min-w-0 flex-1">
        <h2 class="truncate text-2xl font-medium leading-none tracking-[-0.02em] text-display">{{ conversation?.title ?? "选择一个会话" }}</h2>
      </div>
      <button v-if="conversation" class="icon-btn" type="button" aria-label="会话设置" @click="activePanel = 'settings'"><i class="bx bx-cog text-xl" aria-hidden="true"></i></button>
      <button v-if="conversation" class="icon-btn" type="button" aria-label="刷新消息" @click="emit('refresh')"><i class="bx bx-refresh text-xl" aria-hidden="true"></i></button>
      <button v-if="conversation" class="icon-btn" type="button" aria-label="请求日志" @click="openLogs()"><i class="bx bx-file-find text-xl" aria-hidden="true"></i></button>
    </header>

    <div v-if="!conversation" class="empty-state flex-1 dot-grid"><div class="bg-page px-5 py-3"><strong>选择一个会话</strong><p>选择后打开消息记录</p></div></div>
    <template v-else>
      <ConversationQuickControls
        :conversation="conversation"
        :stats="stats"
        @reply="emit('reply', $event)"
        @orchestrator="emit('orchestrator', $event)"
        @usage="activePanel = 'usage'"
      />
      <div
        ref="messageViewport"
        data-slot="message-viewport"
        class="min-h-0 flex-1 overflow-y-auto px-4 py-5 md:px-6"
        tabindex="0"
        @wheel.passive="handleUserScroll"
        @touchend.passive="handleUserScroll"
        @pointerup="handleUserScroll"
        @keyup="handleUserScroll"
        @load.capture="handleContentLoad"
      >
        <div ref="messageContent" data-slot="message-content" class="mx-auto max-w-4xl">
          <button v-if="hasMore" class="btn mx-auto mb-6 flex" type="button" :disabled="loadingMessages" @click="emit('older')">{{ loadingMessages ? "读取中" : "加载更早消息" }}</button>
          <div v-if="loadingMessages && !messages.length" class="py-16 text-center font-mono text-xs text-mute">加载中</div>
          <ConversationMessageBubble
            v-for="message in messages"
            :key="message.id"
            :message="message"
            :conversation="conversation"
            :member-names="memberNames"
            @logs="openLogs"
          />
          <p v-if="error" class="inline-state text-center" data-kind="error">{{ error }}</p>
        </div>
      </div>
    </template>

    <DialogOverlay :open="logsOpen" placement="right" :z-index="60" labelledby="request-logs-title" @close="logsOpen = false">
      <aside class="h-full w-full max-w-2xl overflow-y-auto border-l border-visible bg-panel p-4 md:p-6">
        <div class="flex items-center justify-between gap-4 border-b border-line pb-4">
          <h2 id="request-logs-title" class="text-xl font-medium text-display">请求日志</h2>
          <div class="flex items-center gap-2">
            <button class="btn btn-ghost" type="button" :disabled="loadingLogs" @click="refreshLogs">刷新</button>
            <button class="btn btn-ghost" type="button" @click="logsOpen = false">关闭</button>
          </div>
        </div>
        <p v-if="loadingLogs" class="py-12 text-center font-mono text-xs text-mute">加载中</p>
        <RequestLogList v-if="!loadingLogs" class="mt-5" :logs="logs" enable-search />
      </aside>
    </DialogOverlay>

    <ConversationSidePanel
      v-if="conversation"
      :open="activePanel != null"
      :panel="activePanel ?? 'settings'"
      :conversation="conversation"
      :stats="stats"
      @close="activePanel = null"
      @reply="emit('reply', $event)"
      @orchestrator="emit('orchestrator', $event)"
    />
  </section>
</template>
