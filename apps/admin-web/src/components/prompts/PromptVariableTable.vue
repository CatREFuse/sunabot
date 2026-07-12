<script setup lang="ts">
import type { PromptVariableDefinition } from "../../types";

const props = withDefaults(defineProps<{
  variables: readonly PromptVariableDefinition[];
  usedNames?: readonly string[];
  usageCounts?: Readonly<Record<string, number>>;
  fill?: boolean;
}>(), { usedNames: () => [], usageCounts: () => ({}), fill: false });
const emit = defineEmits<{ insert: [name: string] }>();
const formatVariable = (name: string) => `@{${name}}`;
const isUsed = (name: string) => props.usedNames.includes(name);
const usageCount = (name: string) => props.usageCounts[name] ?? 0;
const referencedVariables = () => props.variables.filter((variable) => usageCount(variable.name) > 0).length;
</script>

<template>
  <div class="variable-context" :class="{ 'variable-context--fill': fill }" role="table" aria-label="提示词变量表">
    <div class="variable-context__heading">
      <span>可用变量</span>
      <span>已引用 {{ referencedVariables() }} / {{ variables.length }}</span>
    </div>
    <div v-if="variables.length" class="variable-context__table">
      <button
        v-for="variable in variables"
        :key="variable.name"
        class="variable-context__row"
        :class="{ 'variable-context__row--used': isUsed(variable.name) }"
        type="button"
        :title="`插入 @{${variable.name}}`"
        @pointerdown.prevent
        @click="emit('insert', variable.name)"
      >
        <span class="variable-context__primary">
          <code>{{ formatVariable(variable.name) }}</code>
          <span>{{ variable.description }}</span>
        </span>
        <span class="variable-context__meta">
          <small>{{ variable.source }}</small>
          <strong v-if="usageCount(variable.name)" class="variable-context__count">×{{ usageCount(variable.name) }}</strong>
          <span v-else class="variable-context__unused">未引用</span>
        </span>
      </button>
    </div>
    <p v-else class="variable-context__empty">当前没有可直接使用的变量</p>
  </div>
</template>

<style scoped>
.variable-context {
  container-type: inline-size;
  border-top: 1px solid rgb(var(--color-line));
  background: rgb(var(--color-raised) / 0.72);
}

.variable-context--fill { display: flex; min-height: 0; flex-direction: column; }

.variable-context__heading {
  display: flex;
  min-height: 40px;
  align-items: center;
  justify-content: space-between;
  padding: 0 16px;
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

.variable-context--fill .variable-context__table { min-height: 0; max-height: none; flex: 1; }

.variable-context__row {
  display: flex;
  width: 100%;
  min-height: 64px;
  flex-direction: column;
  justify-content: center;
  gap: 6px;
  padding: 10px 16px 10px 14px;
  border-bottom: 1px solid rgb(var(--color-line));
  border-left: 2px solid transparent;
  text-align: left;
  color: rgb(var(--color-ink));
}

.variable-context__row:hover,
.variable-context__row:focus-visible {
  background: rgb(var(--color-panel));
}

.variable-context__row:active { background: rgb(var(--color-line)); }

.variable-context__row--used {
  border-left-color: rgb(var(--color-accent));
}

.variable-context__row--used code { color: rgb(var(--color-accent)); }

.variable-context__row code {
  overflow: hidden;
  color: rgb(var(--color-display));
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.variable-context__primary,
.variable-context__primary span,
.variable-context__meta,
.variable-context__meta small {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.variable-context__primary {
  display: flex;
  width: 100%;
  align-items: baseline;
  gap: 10px;
}

.variable-context__primary code { flex: 0 1 auto; }

.variable-context__primary span {
  min-width: 0;
  flex: 1;
  font-size: 12px;
}

.variable-context__meta {
  display: flex;
  width: 100%;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.variable-context__meta small {
  color: rgb(var(--color-mute));
  font-size: 10px;
}

.variable-context__count,
.variable-context__unused {
  flex: none;
  font-family: "Space Mono", monospace;
  font-size: 9px;
  font-weight: 400;
}

.variable-context__count { color: rgb(var(--color-accent)); }
.variable-context__unused { color: rgb(var(--color-mute)); }

.variable-context__empty {
  border-top: 1px solid rgb(var(--color-line));
  padding: 12px;
  font-size: 11px;
  color: rgb(var(--color-mute));
}

@container (max-width: 280px) {
  .variable-context__primary { align-items: flex-start; flex-direction: column; gap: 3px; }
}
</style>
