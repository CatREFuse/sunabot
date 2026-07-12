<script setup lang="ts">
import { computed } from "vue";
import type { PromptVariableDefinition } from "../../types";
import {
  messageGroupToken,
  messageGroupVariableName,
  type PromptMessage
} from "../../utils/finalPromptDocument";
import PromptTextField from "./PromptTextField.vue";

const props = defineProps<{
  message: PromptMessage | string;
  index: number;
  total: number;
  variables: readonly PromptVariableDefinition[];
  semanticXml?: boolean;
  showVariables?: boolean;
}>();
const emit = defineEmits<{
  update: [message: PromptMessage | string];
  move: [direction: -1 | 1];
  remove: [];
}>();
const messageGroups = computed(() => props.variables.filter((variable) => variable.type === "message[]"));
const selectedGroupName = computed(() => typeof props.message === "string" ? messageGroupVariableName(props.message) : "");
const selectedGroup = computed(() => messageGroups.value.find((variable) => variable.name === selectedGroupName.value));

function updateRole(role: string) {
  if (typeof props.message === "string") return;
  emit("update", { ...props.message, role });
}

function updateContent(content: string) {
  if (typeof props.message === "string") return;
  emit("update", { ...props.message, content });
}

function updateGroup(name: string) {
  emit("update", messageGroupToken(name));
}

function onDragHandleKeydown(event: KeyboardEvent) {
  if (!event.altKey) return;
  if (event.key === "ArrowLeft" && props.index > 0) {
    event.preventDefault();
    emit("move", -1);
  } else if (event.key === "ArrowRight" && props.index < props.total - 1) {
    event.preventDefault();
    emit("move", 1);
  }
}
</script>

<template>
  <div class="message-slot">
    <div
      class="message-slot__drag-handle"
      draggable="true"
      data-message-drag-handle
      tabindex="0"
      :aria-label="`拖动消息 ${index + 1} 排序`"
      aria-keyshortcuts="Alt+ArrowLeft Alt+ArrowRight"
      title="拖动排序"
      @keydown="onDragHandleKeydown"
    >
      <span class="message-slot__drag-dots" aria-hidden="true"></span>
    </div>
    <header class="message-slot__header">
      <div class="message-slot__title">
        <h3>{{ typeof message === "string" ? `消息组 ${index + 1}` : `${message.role} 消息 ${index + 1}` }}</h3>
      </div>
      <div class="message-slot__actions">
        <button class="icon-btn message-slot__move-button" type="button" :disabled="index === 0" :aria-label="`前移消息 ${index + 1}`" @click="emit('move', -1)">
          <i class="bx bx-left-arrow-alt text-lg" aria-hidden="true"></i>
        </button>
        <button class="icon-btn message-slot__move-button" type="button" :disabled="index === total - 1" :aria-label="`后移消息 ${index + 1}`" @click="emit('move', 1)">
          <i class="bx bx-right-arrow-alt text-lg" aria-hidden="true"></i>
        </button>
        <button class="icon-btn" type="button" :aria-label="`删除消息 ${index + 1}`" @click="emit('remove')">
          <i class="bx bx-trash text-lg" aria-hidden="true"></i>
        </button>
      </div>
    </header>

    <div v-if="typeof message === 'string'" class="message-slot__group">
      <label class="field">
        <span class="field-label">消息组变量</span>
        <select class="control font-mono" :value="selectedGroupName" aria-label="消息组变量" @change="updateGroup(($event.target as HTMLSelectElement).value)">
          <option v-for="variable in messageGroups" :key="variable.name" :value="variable.name">{{ variable.name }}</option>
        </select>
      </label>
      <dl v-if="selectedGroup" class="message-slot__group-meta">
        <div><dt>说明</dt><dd>{{ selectedGroup.description }}</dd></div>
        <div><dt>来源</dt><dd>{{ selectedGroup.source }}</dd></div>
        <div><dt>类型</dt><dd>message[]</dd></div>
      </dl>
      <p v-else class="message-slot__error">当前消息组变量不可用</p>
    </div>

    <div v-else class="message-slot__message">
      <label class="field message-slot__role">
        <span class="field-label">Role</span>
        <select class="control" :value="message.role" @change="updateRole(($event.target as HTMLSelectElement).value)">
          <option value="system">system</option>
          <option value="user">user</option>
          <option value="assistant">assistant</option>
          <option value="developer">developer</option>
        </select>
      </label>
      <PromptTextField
        :model-value="message.content"
        :variables="variables"
        :label="`${message.role} 提示词`"
        min-height="260px"
        fill
        :semantic-xml="semanticXml"
        :show-variables="showVariables"
        @update:model-value="updateContent"
      />
    </div>
  </div>
</template>

<style scoped>
.message-slot {
  display: flex;
  height: 100%;
  min-width: 0;
  flex-direction: column;
}

.message-slot__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 18px;
}

.message-slot__title {
  min-width: 0;
}

.message-slot__title h3 {
  overflow: hidden;
  color: rgb(var(--color-display));
  font-size: 18px;
  font-weight: 500;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.message-slot__actions {
  display: flex;
  flex: none;
  gap: 4px;
}

.message-slot__drag-handle {
  display: none;
  cursor: grab;
}

.message-slot__drag-handle:active {
  cursor: grabbing;
}

.message-slot__drag-dots {
  width: 72px;
  height: 12px;
  background-image: radial-gradient(circle, rgb(var(--color-mute) / 0.72) 1px, transparent 1.2px);
  background-position: center;
  background-size: 6px 6px;
}

.message-slot__message,
.message-slot__group {
  display: grid;
  gap: 16px;
}

.message-slot__message { min-height: 0; flex: 1; grid-template-rows: auto minmax(0, 1fr); }

.message-slot__role {
  width: min(220px, 100%);
}

.message-slot__group-meta {
  border-top: 1px solid rgb(var(--color-line));
}

.message-slot__group-meta div {
  display: grid;
  grid-template-columns: 56px minmax(0, 1fr);
  gap: 12px;
  border-bottom: 1px solid rgb(var(--color-line));
  padding: 12px 0;
}

.message-slot__group-meta dt {
  font-family: "Space Mono", monospace;
  font-size: 10px;
  color: rgb(var(--color-mute));
}

.message-slot__group-meta dd {
  min-width: 0;
  color: rgb(var(--color-ink));
  font-size: 12px;
}

.message-slot__error {
  color: rgb(var(--color-accent));
  font-size: 12px;
}

@container final-prompt (max-width: 520px) {
  .message-slot__actions .icon-btn {
    width: 40px;
    height: 40px;
  }
}

</style>
