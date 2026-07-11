<script setup lang="ts">
import type { PromptVariableDefinition } from "../../types";

defineProps<{ variables: readonly PromptVariableDefinition[] }>();
const emit = defineEmits<{ insert: [name: string] }>();
const formatVariable = (name: string) => `@{${name}}`;
</script>

<template>
  <div class="variable-context">
    <div class="variable-context__heading">
      <span>可用变量</span>
      <span>{{ variables.length }}</span>
    </div>
    <div v-if="variables.length" class="variable-context__table">
      <button
        v-for="variable in variables"
        :key="variable.name"
        class="variable-context__row"
        type="button"
        :title="`插入 @{${variable.name}}`"
        @click="emit('insert', variable.name)"
      >
        <code>{{ formatVariable(variable.name) }}</code>
        <span>{{ variable.description }}</span>
        <small>{{ variable.source }}</small>
      </button>
    </div>
    <p v-else class="variable-context__empty">当前没有可直接使用的变量</p>
  </div>
</template>

<style scoped>
.variable-context {
  container-type: inline-size;
  border-top: 1px solid rgb(var(--color-line));
  background: rgb(var(--color-raised));
}

.variable-context__heading {
  display: flex;
  justify-content: space-between;
  padding: 8px 12px;
  font-family: "Space Mono", monospace;
  font-size: 10px;
  letter-spacing: 0.06em;
  color: rgb(var(--color-mute));
}

.variable-context__table {
  max-height: 152px;
  overflow-y: auto;
  border-top: 1px solid rgb(var(--color-line));
}

.variable-context__row {
  display: grid;
  width: 100%;
  min-height: 40px;
  grid-template-columns: minmax(112px, 0.9fr) minmax(0, 1.6fr) minmax(80px, 0.6fr);
  align-items: center;
  gap: 12px;
  padding: 8px 12px;
  border-bottom: 1px solid rgb(var(--color-line));
  text-align: left;
  color: rgb(var(--color-ink));
}

.variable-context__row:hover,
.variable-context__row:focus-visible {
  background: rgb(var(--color-panel));
}

.variable-context__row code {
  overflow: hidden;
  color: rgb(var(--color-display));
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.variable-context__row span,
.variable-context__row small {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.variable-context__row span {
  font-size: 12px;
}

.variable-context__row small {
  color: rgb(var(--color-mute));
  font-size: 10px;
}

.variable-context__empty {
  border-top: 1px solid rgb(var(--color-line));
  padding: 12px;
  font-size: 11px;
  color: rgb(var(--color-mute));
}

@container (max-width: 520px) {
  .variable-context__row {
    grid-template-columns: minmax(96px, 0.8fr) minmax(0, 1.2fr);
    gap: 8px;
  }

  .variable-context__row small {
    display: none;
  }
}

@container (max-width: 280px) {
  .variable-context__row {
    grid-template-columns: 1fr;
    gap: 2px;
  }
}
</style>
