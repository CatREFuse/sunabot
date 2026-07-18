<script setup lang="ts">
import { computed, onBeforeUnmount, shallowRef, watch } from "vue";
import type { ConversationOrchestratorStatus } from "../../types";

const props = withDefaults(defineProps<{
  status: ConversationOrchestratorStatus;
  enabled?: boolean;
  variant?: "inline" | "widget";
}>(), {
  enabled: true,
  variant: "inline"
});
const now = shallowRef(Date.now());
let timer: number | undefined;
const timerSegments = Array.from({ length: 12 });

const elapsedSeconds = computed(() => {
  const lastMessageAt = Date.parse(props.status.lastMessageAt);
  if (!Number.isFinite(lastMessageAt)) return 0;
  return Math.max(0, Math.floor((now.value - lastMessageAt) / 1_000));
});
const windowSeconds = computed(() => Math.max(1, Math.ceil(props.status.activeWindowMs / 1_000)));
const active = computed(() => props.enabled && props.status.active);
const judging = computed(() => active.value && (
  props.status.messageCount >= props.status.messageTarget ||
  elapsedSeconds.value >= windowSeconds.value
));
const statusLabel = computed(() => {
  if (!props.enabled) return "已关闭";
  if (!props.status.active) return "未激活";
  return judging.value ? "判断中" : "已激活";
});
const statusTone = computed(() => judging.value || !active.value ? "text-warning" : "text-success");
const filledSegments = computed(() => active.value
  ? Math.min(timerSegments.length, Math.ceil((elapsedSeconds.value / windowSeconds.value) * timerSegments.length))
  : 0);
const displayElapsedSeconds = computed(() => active.value ? Math.min(elapsedSeconds.value, windowSeconds.value) : "--");

watch(
  () => active.value,
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
  <span
    v-if="variant === 'widget'"
    data-slot="orchestrator-status"
    class="orchestrator-widget"
    :data-disabled="!active"
    role="status"
    aria-label="编排器状态"
  >
    <span class="sr-only">编排器状态</span>
    <span class="orchestrator-widget__label">编排器窗口</span>
    <span class="orchestrator-widget__readout">
      <strong class="orchestrator-widget__time">{{ displayElapsedSeconds }}</strong>
      <span class="orchestrator-widget__limit">/ {{ windowSeconds }}<small>秒</small></span>
      <strong class="orchestrator-widget__state" :class="statusTone">{{ statusLabel }}</strong>
    </span>
    <span class="orchestrator-widget__timer" aria-hidden="true">
      <i v-for="(_, index) in timerSegments" :key="index" :data-on="index < filledSegments"></i>
    </span>
  </span>

  <div v-else data-slot="orchestrator-status" class="flex min-h-11 flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[10px] text-mute" role="status" aria-label="编排器状态">
    <span>编排器状态</span>
    <strong class="font-sans text-xs font-medium" :class="statusTone">{{ statusLabel }}</strong>
    <template v-if="active && !judging">
      <span>消息 {{ status.messageCount }} / {{ status.messageTarget }}</span>
      <span>时间 {{ elapsedSeconds }} / {{ windowSeconds }} 秒</span>
    </template>
  </div>
</template>

<style scoped>
.orchestrator-widget {
  display: flex;
  min-width: 0;
  flex-direction: column;
  justify-content: center;
  gap: 8px;
  overflow: hidden;
  border-left: 1px solid rgb(var(--color-line));
  padding: 12px 20px;
}
.orchestrator-widget__label {
  color: rgb(var(--color-disabled));
  font-family: "Space Mono", monospace;
  font-size: 10px;
  line-height: 1;
  letter-spacing: .1em;
  text-transform: uppercase;
}
.orchestrator-widget__readout { display: flex; min-width: 0; align-items: baseline; gap: 5px; white-space: nowrap; }
.orchestrator-widget__time {
  color: rgb(var(--color-display));
  font-family: "Doto Variable", "Space Mono", monospace;
  font-size: 24px;
  font-weight: 700;
  line-height: 1;
  letter-spacing: -.035em;
}
.orchestrator-widget__limit {
  color: rgb(var(--color-mute));
  font-family: "Doto Variable", "Space Mono", monospace;
  font-size: 15px;
  font-weight: 700;
  line-height: 1;
  letter-spacing: -.02em;
}
.orchestrator-widget__limit small { margin-left: 2px; font-family: "Space Mono", monospace; font-size: 9px; font-weight: 400; letter-spacing: .04em; }
.orchestrator-widget__state { margin-left: 7px; font-family: "Space Mono", monospace; font-size: 10px; font-weight: 400; line-height: 1; }
.orchestrator-widget__timer { display: flex; height: 22px; align-items: end; gap: 3px; }
.orchestrator-widget__timer i { width: 5px; height: 8px; flex: 0 0 5px; background: rgb(var(--color-visible)); transition: height 180ms ease, background 180ms ease; }
.orchestrator-widget__timer i[data-on="true"] { height: 20px; background: rgb(var(--color-success)); }
.orchestrator-widget[data-disabled="true"] .orchestrator-widget__time,
.orchestrator-widget[data-disabled="true"] .orchestrator-widget__limit { color: rgb(var(--color-disabled)); }

@container (max-width: 980px) {
  .orchestrator-widget { padding-inline: 14px; }
}
@container (max-width: 720px) {
  .orchestrator-widget { gap: 7px; padding: 10px; }
  .orchestrator-widget__label { font-size: 9px; }
  .orchestrator-widget__time { font-size: 18px; }
  .orchestrator-widget__limit { font-size: 13px; }
  .orchestrator-widget__state { margin-left: 3px; font-size: 9px; }
  .orchestrator-widget__timer { gap: 2px; }
  .orchestrator-widget__timer i { width: 3px; flex-basis: 3px; }
}
</style>
