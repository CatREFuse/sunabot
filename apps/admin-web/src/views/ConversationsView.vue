<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, shallowRef, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useConversations } from "../composables/useConversations";
import ConversationList from "../components/conversations/ConversationList.vue";
import ConversationThread from "../components/conversations/ConversationThread.vue";
import type { ConversationRecord } from "../types";

type Scope = "all" | ConversationRecord["scope"];
const route = useRoute();
const router = useRouter();
const data = useConversations();
const query = shallowRef("");
const scope = shallowRef<Scope>("all");
const selectedId = computed(() => String(route.params.conversationId ?? ""));
const selected = computed(() => data.conversations.value.find((item) => item.id === selectedId.value) ?? null);
let listTimer: number | undefined;
let messageTimer: number | undefined;
let statsTimer: number | undefined;

onMounted(() => {
  void data.loadList();
  listTimer = window.setInterval(() => {
    if (document.visibilityState === "visible") void data.loadList();
  }, 10_000);
});
onBeforeUnmount(() => {
  if (listTimer) window.clearInterval(listTimer);
  if (messageTimer) window.clearInterval(messageTimer);
  if (statsTimer) window.clearInterval(statsTimer);
  data.dispose();
});
watch(selectedId, (id) => {
  data.clearCurrent();
  if (messageTimer) window.clearInterval(messageTimer);
  if (statsTimer) window.clearInterval(statsTimer);
  if (!id) return;
  void data.loadMessages(id, { reset: true });
  void data.loadStats(id);
  messageTimer = window.setInterval(() => {
    if (document.visibilityState === "visible") void data.loadMessages(id);
  }, 2_000);
  statsTimer = window.setInterval(() => {
    if (document.visibilityState === "visible") void data.loadStats(id);
  }, 10_000);
}, { immediate: true });

function select(id: string) { void router.push(`/conversations/${encodeURIComponent(id)}`); }
function back() { void router.push("/conversations"); }
function refreshMessages() {
  if (!selectedId.value) return;
  void data.loadMessages(selectedId.value);
  void data.loadStats(selectedId.value);
}
function older() { if (selectedId.value) void data.loadMessages(selectedId.value, { older: true }); }
function logs(runId?: string) { if (selectedId.value) void data.loadLogs(selectedId.value, runId); }
async function reply(enabled: boolean) { if (selected.value) await data.setReplyEnabled(selected.value, enabled); }
async function orchestrator(enabled: boolean) { if (selected.value) await data.setOrchestratorEnabled(selected.value, enabled); }
</script>

<template>
  <div class="grid h-full min-h-0 min-w-0 lg:grid-cols-[320px_minmax(0,1fr)] xl:grid-cols-[360px_minmax(0,1fr)]">
    <ConversationList
      :class="selectedId ? 'hidden lg:flex' : 'flex'"
      :conversations="data.conversations.value"
      :selected-id="selectedId"
      :loading="data.loadingList.value"
      v-model:query="query"
      v-model:scope="scope"
      @select="select"
      @refresh="data.loadList"
    />
    <ConversationThread
      :class="selectedId ? 'flex' : 'hidden lg:flex'"
      :conversation="selected"
      :messages="data.messages.value"
      :member-names="data.memberNames.value"
      :logs="data.logs.value"
      :stats="data.stats.value"
      :has-more="data.hasMore.value"
      :loading-messages="data.loadingMessages.value"
      :loading-logs="data.loadingLogs.value"
      :error="data.error.value"
      @back="back"
      @refresh="refreshMessages"
      @older="older"
      @logs="logs"
      @reply="reply"
      @orchestrator="orchestrator"
    />
  </div>
</template>
