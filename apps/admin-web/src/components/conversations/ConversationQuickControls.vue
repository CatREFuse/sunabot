<script setup lang="ts">
import { computed } from "vue";
import type { ConversationRecord, ConversationStatsPayload } from "../../types";
import { formatDashboardMetric, formatExactNumber } from "../../utils/numberFormat";
import { conversationIdentityDetail } from "../../utils/qqIdentity";
import ToggleSwitch from "../ui/ToggleSwitch.vue";
import ConversationOrchestratorStatus from "./ConversationOrchestratorStatus.vue";

const props = defineProps<{
  conversation: ConversationRecord;
  stats?: ConversationStatsPayload | null;
}>();
const emit = defineEmits<{
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
const tokenTotal = computed(() => props.stats?.modelCalls.total.total);
const tokenMetric = computed(() => tokenTotal.value == null ? "--" : formatDashboardMetric(tokenTotal.value));
const tokenExact = computed(() => tokenTotal.value == null ? "统计中" : `${formatExactNumber(tokenTotal.value)} Token`);
</script>

<template>
  <section class="border-b border-line px-4 py-2 md:px-6" aria-label="会话快捷操作">
    <div class="flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
      <span class="min-w-0 font-mono text-[10px] text-mute">
        {{ conversation.messageCount }} 条消息 · {{ conversationIdentityDetail(conversation) }}
      </span>
      <div class="flex min-w-0 flex-1 flex-wrap items-center justify-end gap-x-5 gap-y-2 sm:flex-none">
        <ToggleSwitch v-model="replyEnabled" class="min-w-24" label="启动" />
        <ToggleSwitch
          v-if="conversation.scope === 'user_group'"
          v-model="orchestratorEnabled"
          class="min-w-28"
          label="编排器"
          :disabled="!replyEnabled"
        />
        <button
          data-slot="token-usage-widget"
          class="group flex min-h-11 min-w-32 items-center gap-3 border-l border-line pl-4 text-left hover:text-display focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[rgb(var(--color-interactive))]"
          type="button"
          aria-label="查看 Token 消耗详情"
          :title="tokenExact"
          @click="emit('usage')"
        >
          <span class="min-w-0">
            <span class="block text-[10px] text-mute">Token 消耗</span>
            <strong class="block font-mono text-sm font-medium text-display">{{ tokenMetric }}</strong>
          </span>
          <i class="bx bx-chevron-right text-xl text-mute transition-transform group-hover:translate-x-0.5 group-hover:text-display" aria-hidden="true"></i>
        </button>
      </div>
    </div>
    <ConversationOrchestratorStatus
      v-if="conversation.scope === 'user_group' && replyEnabled && orchestratorEnabled && conversation.orchestratorStatus"
      :status="conversation.orchestratorStatus"
    />
  </section>
</template>
