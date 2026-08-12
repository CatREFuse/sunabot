<script setup lang="ts">
import type { ConversationRecord } from "../../types";
import ToggleSwitch from "../ui/ToggleSwitch.vue";

defineProps<{
  conversation: ConversationRecord;
  replyEnabled: boolean;
  orchestratorEnabled: boolean;
  orchestratorResponseTimeOverrideEnabled: boolean;
  orchestratorResponseTimeSeconds: number;
  directorEventsEnabled: boolean;
  busy: boolean;
}>();
const emit = defineEmits<{
  updateReplyEnabled: [enabled: boolean];
  updateOrchestratorEnabled: [enabled: boolean];
  updateOrchestratorResponseTimeOverrideEnabled: [enabled: boolean];
  updateOrchestratorResponseTimeSeconds: [seconds: number];
  updateDirectorEventsEnabled: [enabled: boolean];
}>();

function updateResponseTime(event: Event) {
  const seconds = Number((event.target as HTMLInputElement).value);
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 3_600) return;
  emit("updateOrchestratorResponseTimeSeconds", seconds);
}
</script>

<template>
  <section aria-labelledby="conversation-reply-title">
    <header class="border-b border-visible pb-4">
      <h2 id="conversation-reply-title" class="section-title">回复</h2>
    </header>
    <div class="divider-row py-5">
      <div class="min-w-0">
        <strong class="block text-sm font-medium text-display">允许回复</strong>
        <p class="mt-1 text-xs leading-5 text-mute">接收新消息后生成并发送回复</p>
      </div>
      <ToggleSwitch
        :model-value="replyEnabled"
        label="允许回复"
        :disabled="busy"
        @update:model-value="emit('updateReplyEnabled', $event)"
      />
    </div>
    <div v-if="conversation.scope === 'user_group'" class="divider-row py-5">
      <div class="min-w-0">
        <strong class="block text-sm font-medium text-display">群聊编排器</strong>
        <p class="mt-1 text-xs leading-5 text-mute">根据群聊上下文判断是否参与对话</p>
      </div>
      <ToggleSwitch
        :model-value="orchestratorEnabled"
        label="群聊编排器"
        :disabled="busy || !replyEnabled"
        @update:model-value="emit('updateOrchestratorEnabled', $event)"
      />
    </div>
    <div v-if="conversation.scope === 'user_group'" class="divider-row py-5">
      <div class="min-w-0">
        <strong class="block text-sm font-medium text-display">编排器时间覆盖</strong>
        <p class="mt-1 text-xs leading-5 text-mute">为当前会话设置独立响应时间</p>
      </div>
      <ToggleSwitch
        :model-value="orchestratorResponseTimeOverrideEnabled"
        label="编排器时间覆盖"
        :disabled="busy || !replyEnabled || !orchestratorEnabled"
        @update:model-value="emit('updateOrchestratorResponseTimeOverrideEnabled', $event)"
      />
    </div>
    <label
      v-if="conversation.scope === 'user_group' && orchestratorResponseTimeOverrideEnabled"
      class="divider-row py-5"
    >
      <span class="min-w-0">
        <strong class="block text-sm font-medium text-display">响应时间 / 秒</strong>
        <span class="mt-1 block text-xs leading-5 text-mute">1—3600 秒</span>
      </span>
      <input
        class="control w-28"
        type="number"
        min="1"
        max="3600"
        step="1"
        :value="orchestratorResponseTimeSeconds"
        :disabled="busy || !replyEnabled || !orchestratorEnabled"
        aria-label="编排器响应时间"
        @change="updateResponseTime"
      >
    </label>
    <div class="divider-row py-5">
      <div class="min-w-0">
        <strong class="block text-sm font-medium text-display">导演事件</strong>
        <p class="mt-1 text-xs leading-5 text-mute">接收导演系统的主动分享</p>
      </div>
      <ToggleSwitch
        :model-value="directorEventsEnabled"
        label="导演事件"
        :disabled="busy"
        @update:model-value="emit('updateDirectorEventsEnabled', $event)"
      />
    </div>
  </section>
</template>
