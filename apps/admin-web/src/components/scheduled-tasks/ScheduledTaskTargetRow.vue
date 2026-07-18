<script setup lang="ts">
import { computed, shallowRef, useId } from "vue";
import type { ConversationRecord } from "../../types";
import type { ScheduledTaskTarget } from "../../types/scheduledTasks";
import {
  isGroupConversationId,
  MAX_SCHEDULED_TASK_MENTIONS,
  validMentionUserId
} from "./cronSchedule";

const props = defineProps<{
  target: ScheduledTaskTarget;
  conversations: readonly ConversationRecord[];
  removable: boolean;
}>();
const emit = defineEmits<{
  update: [target: ScheduledTaskTarget];
  remove: [];
}>();
const mentionInput = shallowRef("");
const mentionError = shallowRef("");
const listId = `scheduled-task-conversations-${useId()}`;
const groupTarget = computed(() => isGroupConversationId(props.target.conversationId));
const selectedConversation = computed(() => props.conversations.find((item) => item.id === props.target.conversationId));
const mentionLimitReached = computed(() => props.target.mentionUserIds.length >= MAX_SCHEDULED_TASK_MENTIONS);

function updateConversation(event: Event) {
  const conversationId = (event.target as HTMLInputElement).value;
  emit("update", {
    conversationId,
    mentionUserIds: isGroupConversationId(conversationId) ? [...props.target.mentionUserIds] : []
  });
  mentionError.value = "";
}

function addMention() {
  const userId = mentionInput.value.trim();
  if (!validMentionUserId(userId)) {
    mentionError.value = "请输入有效的 QQ 号";
    return;
  }
  if (props.target.mentionUserIds.includes(userId)) {
    mentionError.value = "该 QQ 号已添加";
    return;
  }
  if (mentionLimitReached.value) {
    mentionError.value = `每个会话最多添加 ${MAX_SCHEDULED_TASK_MENTIONS} 个 @ 对象`;
    return;
  }
  emit("update", {
    ...props.target,
    mentionUserIds: [...props.target.mentionUserIds, userId]
  });
  mentionInput.value = "";
  mentionError.value = "";
}

function removeMention(userId: string) {
  emit("update", {
    ...props.target,
    mentionUserIds: props.target.mentionUserIds.filter((item) => item !== userId)
  });
}
</script>

<template>
  <article class="grid gap-4 border-t border-line py-5 first:border-t-0">
    <div class="flex items-start gap-3">
      <label class="field min-w-0 flex-1">
        <span class="field-label">回调会话</span>
        <input
          :value="target.conversationId"
          class="control font-mono"
          type="text"
          :list="listId"
          autocomplete="off"
          placeholder="group:10001"
          @input="updateConversation"
        >
        <datalist :id="listId">
          <option v-for="conversation in conversations" :key="conversation.id" :value="conversation.id">{{ conversation.title }}</option>
        </datalist>
        <small v-if="selectedConversation" class="truncate text-xs text-mute">{{ selectedConversation.title }}</small>
      </label>
      <button class="icon-btn mt-5" type="button" :disabled="!removable" aria-label="删除回调会话" @click="emit('remove')">
        <i class="bx bx-trash text-xl" aria-hidden="true"></i>
      </button>
    </div>

    <div v-if="groupTarget" class="field">
      <span class="field-label">@ QQ 号</span>
      <div class="flex flex-col gap-2 sm:flex-row">
        <input v-model="mentionInput" class="control min-w-0 flex-1" type="text" inputmode="numeric" autocomplete="off" placeholder="输入 QQ 号" :disabled="mentionLimitReached" @keydown.enter.prevent="addMention">
        <button class="btn shrink-0" type="button" :disabled="mentionLimitReached" @click="addMention"><i class="bx bx-at" aria-hidden="true"></i>添加</button>
      </div>
      <div v-if="target.mentionUserIds.length" class="flex flex-wrap gap-2 pt-1">
        <button
          v-for="userId in target.mentionUserIds"
          :key="userId"
          class="inline-flex min-h-9 items-center gap-1 rounded-full border border-visible px-3 font-mono text-xs text-ink hover:border-display"
          type="button"
          :aria-label="`移除 @${userId}`"
          @click="removeMention(userId)"
        >
          @{{ userId }}<i class="bx bx-x" aria-hidden="true"></i>
        </button>
      </div>
      <small v-if="mentionLimitReached" class="text-xs text-mute">每个会话最多添加 {{ MAX_SCHEDULED_TASK_MENTIONS }} 个 @ 对象</small>
      <small v-if="mentionError" class="text-xs text-accent">{{ mentionError }}</small>
    </div>
    <p v-else-if="target.conversationId" class="text-xs text-mute">私聊将直接发送，无需 @</p>
  </article>
</template>
