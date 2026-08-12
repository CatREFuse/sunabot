<script setup lang="ts">
import { conversationIdentityDetail } from "../../utils/qqIdentity";
import ToggleSwitch from "../ui/ToggleSwitch.vue";

interface DirectorConversationTarget {
  readonly id: string;
  readonly scope: "private" | "user_group" | "bot_group";
  readonly title: string;
  readonly userId: number;
  readonly groupId?: number;
  readonly nickname?: string;
  readonly remark?: string;
  readonly directorEventsEnabled?: boolean;
}

defineProps<{
  conversations: readonly DirectorConversationTarget[];
  savingIds: readonly string[];
  loading: boolean;
}>();

const emit = defineEmits<{
  toggle: [conversationId: string, enabled: boolean];
}>();

function scopeLabel(conversation: DirectorConversationTarget) {
  return conversation.groupId ? "群聊" : "私聊";
}
</script>

<template>
  <section aria-label="发送会话">
    <ul v-if="conversations.length" class="divide-y divide-line">
      <li v-for="conversation in conversations" :key="conversation.id" class="target-row">
        <div class="min-w-0">
          <div class="target-title">
            <strong>{{ conversation.title }}</strong>
            <span>{{ scopeLabel(conversation) }}</span>
          </div>
          <p>{{ conversationIdentityDetail(conversation) }}</p>
        </div>
        <ToggleSwitch
          :model-value="conversation.directorEventsEnabled === true"
          :label="`${conversation.title}导演事件`"
          :disabled="savingIds.includes(conversation.id)"
          @update:model-value="emit('toggle', conversation.id, $event)"
        />
      </li>
    </ul>
    <div v-else class="empty-state">
      <strong>{{ loading ? "正在读取发送会话" : "还没有会话" }}</strong>
    </div>
  </section>
</template>

<style scoped>
.target-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 24px;
  align-items: center;
  min-height: 72px;
  padding: 16px 0;
}
.target-title { display: flex; flex-wrap: wrap; gap: 8px 12px; align-items: baseline; }
.target-title strong { color: rgb(var(--color-display)); font-size: 14px; font-weight: 500; }
.target-title span, .target-row p { color: rgb(var(--color-mute)); font-size: 11px; }
.target-row p { margin-top: 6px; font-family: "Space Mono", monospace; }
@media (max-width: 639px) {
  .target-row { gap: 12px; }
}
</style>
