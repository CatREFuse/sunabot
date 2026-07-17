<script setup lang="ts">
import type { ConversationRecord } from "../../types";
import ToggleSwitch from "../ui/ToggleSwitch.vue";

defineProps<{
  conversation: ConversationRecord;
  replyEnabled: boolean;
  orchestratorEnabled: boolean;
  busy: boolean;
}>();
const emit = defineEmits<{
  updateReplyEnabled: [enabled: boolean];
  updateOrchestratorEnabled: [enabled: boolean];
}>();
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
  </section>
</template>
