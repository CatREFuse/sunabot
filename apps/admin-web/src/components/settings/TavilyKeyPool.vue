<script setup lang="ts">
import { computed } from "vue";
import type { BotToolSettingsDraft, ConfigEnvelope } from "../../types";

const draft = defineModel<BotToolSettingsDraft["websearch"]>({ required: true });
const props = defineProps<{
  fieldState?: ConfigEnvelope["fieldStates"][string];
}>();

const storedCount = computed(() => props.fieldState?.storedSecretCount ?? 0);
const storedIndexes = computed(() => Array.from({ length: storedCount.value }, (_, index) => index));
const pendingCount = computed(() => draft.value.tavilyApiKeys.filter((key) => key.trim()).length);
const removedCount = computed(() => draft.value.removeTavilyApiKeyIndexes.length);
const retainedStoredCount = computed(() => Math.max(0, storedCount.value - removedCount.value));
const environmentCount = computed(() => Math.max(0, (props.fieldState?.secretCount ?? 0) - storedCount.value));

function addKey() {
  draft.value.tavilyApiKeys.push("");
}

function removeNewKey(index: number) {
  draft.value.tavilyApiKeys.splice(index, 1);
}

function toggleStoredKey(index: number) {
  const removalIndex = draft.value.removeTavilyApiKeyIndexes.indexOf(index);
  if (removalIndex >= 0) draft.value.removeTavilyApiKeyIndexes.splice(removalIndex, 1);
  else draft.value.removeTavilyApiKeyIndexes.push(index);
}

function isMarkedForRemoval(index: number) {
  return draft.value.removeTavilyApiKeyIndexes.includes(index);
}
</script>

<template>
  <section class="key-pool">
    <header class="key-pool__header">
      <div>
        <span class="field-label">Tavily Key 池</span>
        <p class="key-pool__summary">
          {{ retainedStoredCount }} 个已保存
          <template v-if="pendingCount"> · {{ pendingCount }} 个待保存</template>
          <template v-if="environmentCount"> · {{ environmentCount }} 个环境变量来源</template>
        </p>
      </div>
      <button class="btn btn-ghost" type="button" @click="addKey">
        <i class="bx bx-plus" aria-hidden="true"></i>
        添加 Key
      </button>
    </header>

    <div v-if="storedIndexes.length || draft.tavilyApiKeys.length" class="key-pool__list">
      <div
        v-for="index in storedIndexes"
        :key="`stored-${index}`"
        class="key-pool__row"
        :class="{ 'key-pool__row--removed': isMarkedForRemoval(index) }"
      >
        <div class="key-pool__identity">
          <span>Key {{ index + 1 }}</span>
          <small>{{ isMarkedForRemoval(index) ? "[PENDING DELETE]" : "[SAVED]" }}</small>
        </div>
        <span class="key-pool__masked" aria-hidden="true">•••• •••• ••••</span>
        <button
          class="icon-btn"
          type="button"
          :aria-label="isMarkedForRemoval(index) ? `撤销删除 Key ${index + 1}` : `删除 Key ${index + 1}`"
          @click="toggleStoredKey(index)"
        >
          <i v-if="isMarkedForRemoval(index)" class="bx bx-reset" aria-hidden="true"></i>
          <i v-else class="bx bx-trash" aria-hidden="true"></i>
        </button>
      </div>

      <div v-for="(_, index) in draft.tavilyApiKeys" :key="`new-${index}`" class="key-pool__row key-pool__row--new">
        <span class="key-pool__identity">
          <span>新 Key {{ index + 1 }}</span>
          <small>[UNSAVED]</small>
        </span>
        <input
          v-model.trim="draft.tavilyApiKeys[index]"
          class="control"
          type="password"
          autocomplete="new-password"
          :aria-label="`Tavily API Key ${index + 1}`"
          placeholder="tvly-..."
        >
        <button class="icon-btn" type="button" :aria-label="`移除新 Key ${index + 1}`" @click.prevent="removeNewKey(index)">
          <i class="bx bx-trash" aria-hidden="true"></i>
        </button>
      </div>
    </div>
    <p v-else class="key-pool__empty">还没有保存 Key</p>
  </section>
</template>

<style scoped>
.key-pool {
  display: grid;
  gap: 12px;
}

.key-pool__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}

.key-pool__summary {
  margin-top: 4px;
  color: rgb(var(--color-mute));
  font-family: "Space Mono", monospace;
  font-size: 10px;
}

.key-pool__list {
  border-top: 1px solid rgb(var(--color-line));
}

.key-pool__row {
  display: grid;
  min-height: 64px;
  grid-template-columns: minmax(120px, 0.7fr) minmax(160px, 1fr) 44px;
  align-items: center;
  gap: 16px;
  border-bottom: 1px solid rgb(var(--color-line));
  transition: opacity 160ms ease;
}

.key-pool__row--removed {
  opacity: 0.48;
}

.key-pool__identity {
  display: grid;
  gap: 3px;
  color: rgb(var(--color-ink));
  font-size: 13px;
}

.key-pool__identity small {
  color: rgb(var(--color-mute));
  font-family: "Space Mono", monospace;
  font-size: 9px;
}

.key-pool__masked {
  color: rgb(var(--color-mute));
  font-family: "Space Mono", monospace;
  font-size: 12px;
  letter-spacing: 0.08em;
}

.key-pool__empty {
  border-top: 1px solid rgb(var(--color-line));
  border-bottom: 1px solid rgb(var(--color-line));
  padding: 16px 0;
  color: rgb(var(--color-mute));
  font-size: 12px;
}

@media (max-width: 640px) {
  .key-pool__header {
    align-items: flex-start;
  }

  .key-pool__row {
    grid-template-columns: minmax(0, 1fr) 44px;
    gap: 8px;
    padding: 12px 0;
  }

  .key-pool__masked,
  .key-pool__row--new .control {
    grid-column: 1;
  }

  .key-pool__row .icon-btn {
    grid-row: 1 / span 2;
    grid-column: 2;
  }
}
</style>
