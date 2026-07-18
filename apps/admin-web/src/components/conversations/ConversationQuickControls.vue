<script setup lang="ts">
import { computed } from "vue";
import type { ConversationRecord, ConversationStatsPayload } from "../../types";
import { formatDashboardMetric, formatExactNumber } from "../../utils/numberFormat";
import ToggleSwitch from "../ui/ToggleSwitch.vue";
import ConversationOrchestratorStatus from "./ConversationOrchestratorStatus.vue";

const props = defineProps<{
  conversation: ConversationRecord;
  stats?: ConversationStatsPayload | null;
}>();
const emit = defineEmits<{
  back: [];
  settings: [];
  refresh: [];
  logs: [];
  reply: [enabled: boolean];
  orchestrator: [enabled: boolean];
  usage: [];
}>();

const replyEnabled = computed({
  get: () => props.conversation.replyEnabled !== false,
  set: (value) => emit("reply", value)
});
const orchestratorEnabled = computed({
  get: () => props.conversation.orchestratorEnabled !== false,
  set: (value) => emit("orchestrator", value)
});
const isUserGroup = computed(() => props.conversation.scope === "user_group");
const identityLabel = computed(() => {
  if (props.conversation.scope === "user_group") return `群聊 / ${props.conversation.groupId ?? props.conversation.id}`;
  if (props.conversation.scope === "bot_group") return `BOT 群聊 / ${props.conversation.groupId ?? props.conversation.id}`;
  return `私聊 / ${props.conversation.userId}`;
});
const tokenTotal = computed(() => props.stats?.modelCalls.total.total);
const tokenMetric = computed(() => tokenTotal.value == null ? "--" : formatDashboardMetric(tokenTotal.value));
const tokenExact = computed(() => tokenTotal.value == null ? "统计中" : `${formatExactNumber(tokenTotal.value)} Token`);
const tokenCells = computed(() => Array.from({ length: tokenTotal.value && tokenTotal.value > 0 ? Math.ceil(tokenTotal.value / 1_000_000) : 0 }));
const messageCells = computed(() => Array.from({ length: props.conversation.messageCount > 0 ? Math.ceil(props.conversation.messageCount / 100) : 0 }));
</script>

<template>
  <header class="conversation-console" :data-has-orchestrator="isUserGroup" aria-label="会话快捷操作">
    <section class="conversation-identity" aria-labelledby="conversation-title">
      <button class="icon-btn conversation-back lg:hidden" type="button" aria-label="返回会话列表" @click="emit('back')">
        <i class="bx bx-left-arrow-alt" aria-hidden="true"></i>
      </button>
      <div class="conversation-identity__content">
        <span class="conversation-identity__meta">{{ identityLabel }}</span>
        <h2 id="conversation-title" class="conversation-identity__title">{{ conversation.title }}</h2>
        <div class="conversation-switches" aria-label="会话控制">
          <ToggleSwitch v-model="replyEnabled" class="conversation-switch" label="回复" />
          <ToggleSwitch
            v-if="isUserGroup"
            v-model="orchestratorEnabled"
            class="conversation-switch"
            label="编排"
            :disabled="!replyEnabled"
          />
        </div>
      </div>
    </section>

    <section class="conversation-instruments" :data-count="isUserGroup ? 3 : 2" aria-label="会话数据">
      <button
        data-slot="token-usage-widget"
        class="span-widget span-widget--button"
        type="button"
        aria-label="查看 Token 消耗详情"
        :title="tokenExact"
        @click="emit('usage')"
      >
        <span class="span-widget__label">Token</span>
        <strong class="span-widget__value">{{ tokenMetric }}</strong>
        <span class="span-widget__cells" aria-hidden="true"><i v-for="(_, index) in tokenCells" :key="index"></i></span>
      </button>

      <span class="span-widget">
        <span class="span-widget__label">消息</span>
        <strong class="span-widget__value">{{ conversation.messageCount }}</strong>
        <span class="span-widget__cells" aria-hidden="true"><i v-for="(_, index) in messageCells" :key="index"></i></span>
      </span>

      <ConversationOrchestratorStatus
        v-if="isUserGroup && conversation.orchestratorStatus"
        :status="conversation.orchestratorStatus"
        :enabled="replyEnabled && orchestratorEnabled"
        variant="widget"
      />
    </section>

    <nav class="conversation-tools" aria-label="会话工具">
      <button class="icon-btn" type="button" aria-label="会话设置" @click="emit('settings')"><i class="bx bx-cog" aria-hidden="true"></i></button>
      <button class="icon-btn" type="button" aria-label="刷新消息" @click="emit('refresh')"><i class="bx bx-refresh" aria-hidden="true"></i></button>
      <button class="icon-btn" type="button" aria-label="请求日志" @click="emit('logs')"><i class="bx bx-file-find" aria-hidden="true"></i></button>
    </nav>
  </header>
</template>

<style scoped>
.conversation-console {
  display: grid;
  min-width: 0;
  min-height: 120px;
  grid-template-columns: minmax(300px, .75fr) minmax(0, 1.55fr) 132px;
  border-bottom: 1px solid rgb(var(--color-line));
  background: rgb(var(--color-panel));
}
.conversation-identity {
  position: relative;
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 8px;
  padding: 12px 32px;
}
.conversation-back { flex: 0 0 auto; }
.conversation-identity__content { min-width: 0; }
.conversation-identity__meta {
  display: flex;
  align-items: center;
  color: rgb(var(--color-mute));
  font-family: "Space Mono", monospace;
  font-size: 10px;
  line-height: 1;
  letter-spacing: .1em;
  text-transform: uppercase;
}
.conversation-identity__title {
  overflow: hidden;
  margin: 6px 0 0;
  color: rgb(var(--color-display));
  font-size: clamp(28px, 2.2vw, 36px);
  font-weight: 500;
  line-height: 1;
  letter-spacing: -.04em;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.conversation-switches { display: flex; align-items: center; gap: 20px; margin-top: 12px; }
.conversation-switch { width: auto; min-height: 28px; gap: 8px; }
.conversation-switch :deep(> span:first-child > span:first-child) {
  color: rgb(var(--color-display));
  font-family: "Space Mono", monospace;
  font-size: 10px;
  line-height: 1;
  letter-spacing: .08em;
}
.conversation-switch :deep([data-slot="toggle-track"]) { width: 36px; height: 20px; }
.conversation-switch :deep([data-slot="toggle-thumb"]) { top: 3px; left: 3px; width: 12px; height: 12px; }
.conversation-switch :deep(input:checked + [data-slot="toggle-track"] [data-slot="toggle-thumb"]) { transform: translateX(16px); }

.conversation-instruments { display: grid; min-width: 0; grid-template-columns: minmax(0, .8fr) minmax(0, .8fr) minmax(0, 1.4fr); border-left: 1px solid rgb(var(--color-line)); }
.conversation-instruments[data-count="2"] { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.span-widget {
  display: flex;
  min-width: 0;
  flex-direction: column;
  justify-content: center;
  gap: 8px;
  overflow: hidden;
  border: 0;
  background: transparent;
  padding: 12px 20px;
  text-align: left;
}
.span-widget + .span-widget,
.span-widget + :deep([data-slot="orchestrator-status"]) { border-left: 1px solid rgb(var(--color-line)); }
.span-widget--button { cursor: pointer; }
.span-widget--button:hover .span-widget__value { color: rgb(var(--color-ink)); }
.span-widget__label {
  color: rgb(var(--color-disabled));
  font-family: "Space Mono", monospace;
  font-size: 10px;
  line-height: 1;
  letter-spacing: .1em;
  text-transform: uppercase;
}
.span-widget__value {
  overflow: hidden;
  color: rgb(var(--color-display));
  font-family: "Doto Variable", "Space Mono", monospace;
  font-size: 24px;
  font-weight: 700;
  line-height: 1;
  letter-spacing: -.035em;
  text-overflow: ellipsis;
  white-space: nowrap;
  transition: color 180ms ease;
}
.span-widget__cells { display: flex; max-width: 100%; gap: 4px; overflow-x: auto; scrollbar-width: none; }
.span-widget__cells::-webkit-scrollbar { display: none; }
.span-widget__cells i { width: 10px; height: 6px; flex: 0 0 10px; background: rgb(var(--color-display)); }

.conversation-tools { display: flex; align-items: center; justify-content: center; border-left: 1px solid rgb(var(--color-line)); }
.conversation-tools .icon-btn { width: 40px; height: 44px; }
.conversation-tools .bx { font-size: 21px; }

@container (max-width: 980px) {
  .conversation-console { grid-template-columns: minmax(250px, .7fr) minmax(0, 1.5fr) 108px; }
  .conversation-identity { padding-inline: 20px; }
  .conversation-identity__title { font-size: 28px; }
  .span-widget { padding-inline: 14px; }
  .conversation-tools .icon-btn { width: 34px; }
}

@container (max-width: 720px) {
  .conversation-console { min-height: 212px; grid-template-columns: minmax(0, 1fr) 108px; grid-template-rows: 108px 104px; }
  .conversation-identity { grid-column: 1; grid-row: 1; padding: 10px 16px; }
  .conversation-identity__title { font-size: 28px; }
  .conversation-switches { gap: 16px; margin-top: 10px; }
  .conversation-instruments { grid-column: 1 / -1; grid-row: 2; border-top: 1px solid rgb(var(--color-line)); border-left: 0; }
  .span-widget { gap: 7px; padding: 10px; }
  .span-widget__label { font-size: 9px; }
  .span-widget__value { font-size: 18px; }
  .span-widget__cells i { width: 9px; flex-basis: 9px; }
  .conversation-tools { grid-column: 2; grid-row: 1; }
}

@container (max-width: 440px) {
  .conversation-identity { padding-left: 8px; }
  .conversation-back { display: inline-flex; }
  .conversation-switches { gap: 12px; }
  .conversation-switch :deep([data-slot="toggle-track"]) { width: 32px; height: 18px; }
  .conversation-switch :deep([data-slot="toggle-thumb"]) { width: 10px; height: 10px; }
  .conversation-switch :deep(input:checked + [data-slot="toggle-track"] [data-slot="toggle-thumb"]) { transform: translateX(14px); }
}
</style>
