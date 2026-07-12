<script setup lang="ts">
import { computed } from "vue";
import type { ConversationLogEntry, OneBotEventTrace } from "../../types";
import { oneBotEventDisplayName, oneBotEventId, requestLogDisplayName } from "../../utils/logDisplay";

const props = defineProps<{ logs: readonly ConversationLogEntry[]; events: readonly OneBotEventTrace[] }>();
const lines = computed(() => [
  ...props.logs.map((log) => ({ at: log.at, text: `[${log.action}] ${requestLogDisplayName(log)} ${log.providerId ?? ""} ${log.model ?? ""}`.trim() })),
  ...props.events.map((event) => ({ at: event.receivedAt, text: `[${oneBotEventId(event)}] ${oneBotEventDisplayName(event)} ${event.text ?? ""}`.trim() }))
].sort((left, right) => Date.parse(right.at) - Date.parse(left.at)));
function time(value: string) { return new Date(value).toLocaleString("zh-CN", { hour12: false }); }
</script>

<template>
  <section class="terminal" aria-label="Bot 活动终端">
    <header class="terminal__header"><span>SUNABOT ACTIVITY</span><span>{{ lines.length }} LINES</span></header>
    <div class="terminal__body" role="log">
      <p v-for="(line, index) in lines" :key="`${line.at}-${index}`"><time>{{ time(line.at) }}</time><span>&gt; {{ line.text }}</span></p>
      <p v-if="!lines.length"><span>&gt; 等待活动记录_</span></p>
    </div>
  </section>
</template>

<style scoped>
.terminal { overflow: hidden; border: 1px solid #245c37; border-radius: 8px; background: #020805; color: #6dff9c; font-family: "Space Mono", monospace; }
.terminal__header { display: flex; justify-content: space-between; gap: 16px; border-bottom: 1px solid #245c37; padding: 10px 14px; background: #07140c; color: #42c66c; font-size: 10px; letter-spacing: .08em; }
.terminal__body { min-height: 480px; max-height: calc(100dvh - 280px); overflow: auto; padding: 14px; font-size: 11px; line-height: 1.75; }
.terminal__body p { display: grid; grid-template-columns: 168px minmax(0, 1fr); gap: 12px; margin: 0; border-bottom: 1px solid #0d2817; padding: 4px 0; overflow-wrap: anywhere; }
.terminal__body time { color: #318b50; }
@media (max-width: 600px) { .terminal__body p { grid-template-columns: 1fr; gap: 0; } .terminal__body { min-height: 360px; } }
</style>
