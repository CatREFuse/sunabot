<script setup lang="ts">
import { computed, onBeforeUnmount, shallowRef, watch } from "vue";
import type { ConversationOrchestratorStatus } from "../../types";

const props = defineProps<{ status: ConversationOrchestratorStatus }>();
const now = shallowRef(Date.now());
let timer: number | undefined;

const elapsedSeconds = computed(() => {
  const lastMessageAt = Date.parse(props.status.lastMessageAt);
  if (!Number.isFinite(lastMessageAt)) return 0;
  return Math.max(0, Math.floor((now.value - lastMessageAt) / 1_000));
});
const windowSeconds = computed(() => Math.max(1, Math.ceil(props.status.activeWindowMs / 1_000)));
const judging = computed(() => props.status.active && (
  props.status.messageCount >= props.status.messageTarget ||
  elapsedSeconds.value >= windowSeconds.value
));
const statusLabel = computed(() => {
  if (!props.status.active) return "未激活";
  return judging.value ? "判断中" : "已激活";
});
const statusTone = computed(() => judging.value || !props.status.active ? "text-warning" : "text-success");

watch(
  () => props.status.active,
  (active) => {
    stopTimer();
    now.value = Date.now();
    if (active) timer = window.setInterval(() => { now.value = Date.now(); }, 1_000);
  },
  { immediate: true }
);
onBeforeUnmount(stopTimer);

function stopTimer() {
  if (timer != null) window.clearInterval(timer);
  timer = undefined;
}
</script>

<template>
  <div data-slot="orchestrator-status" class="flex min-h-11 flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[10px] text-mute" role="status" aria-label="编排器状态">
    <span>编排器状态</span>
    <strong class="font-sans text-xs font-medium" :class="statusTone">{{ statusLabel }}</strong>
    <template v-if="status.active && !judging">
      <span>消息 {{ status.messageCount }} / {{ status.messageTarget }}</span>
      <span>时间 {{ elapsedSeconds }} / {{ windowSeconds }} 秒</span>
    </template>
  </div>
</template>
