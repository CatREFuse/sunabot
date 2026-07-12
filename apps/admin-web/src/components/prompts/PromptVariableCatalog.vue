<script setup lang="ts">
import { computed, shallowRef } from "vue";
import type { PromptVariableDefinition } from "../../types";

const props = withDefaults(defineProps<{ variables: readonly PromptVariableDefinition[]; usedNames?: readonly string[] }>(), { usedNames: () => [] });
const query = shallowRef("");
const visibleVariables = computed(() => {
  const term = query.value.trim().toLocaleLowerCase();
  return term
    ? props.variables.filter((item) =>
        `${item.name} ${item.description} ${item.source} ${item.type}`.toLocaleLowerCase().includes(term))
    : props.variables;
});
const formatVariable = (name: string) => `@{${name}}`;
const isUsed = (name: string) => props.usedNames.includes(name);
</script>

<template>
  <section class="variable-catalog">
    <header class="variable-catalog__header">
      <div>
        <p class="page-kicker">VARIABLES</p>
        <h3 class="section-title mt-2">变量表</h3>
      </div>
      <label class="field variable-catalog__search">
        <span class="sr-only">搜索变量</span>
        <input v-model="query" class="control" type="search" placeholder="搜索变量" autocomplete="off">
      </label>
    </header>

    <div class="variable-catalog__table" role="table" aria-label="提示词变量表">
      <div class="variable-catalog__row variable-catalog__row--header" role="row">
        <span role="columnheader">变量</span>
        <span role="columnheader">说明</span>
        <span role="columnheader">类型</span>
        <span role="columnheader">来源</span>
      </div>
      <div v-for="variable in visibleVariables" :key="variable.name" class="variable-catalog__row" :class="{ 'variable-catalog__row--used': isUsed(variable.name) }" role="row">
        <code role="cell"><i v-if="isUsed(variable.name)" class="bx bx-check-circle mr-1" aria-hidden="true"></i>{{ formatVariable(variable.name) }}</code>
        <span role="cell">{{ variable.description }}</span>
        <span role="cell" class="variable-catalog__meta">{{ variable.type }}</span>
        <span role="cell" class="variable-catalog__meta">{{ variable.source }}</span>
      </div>
    </div>
    <p v-if="!visibleVariables.length" class="variable-catalog__empty">没有匹配变量</p>
  </section>
</template>

<style scoped>
.variable-catalog {
  height: 100%;
  overflow-y: auto;
  padding: 24px;
}

.variable-catalog__header {
  display: flex;
  align-items: end;
  justify-content: space-between;
  gap: 24px;
  margin-bottom: 32px;
}

.variable-catalog__search {
  width: min(280px, 100%);
}

.variable-catalog__table {
  border-top: 1px solid rgb(var(--color-visible));
}

.variable-catalog__row {
  display: grid;
  grid-template-columns: minmax(180px, 1fr) minmax(240px, 2fr) minmax(96px, 0.6fr) minmax(120px, 0.8fr);
  gap: 16px;
  align-items: center;
  min-height: 52px;
  border-bottom: 1px solid rgb(var(--color-line));
  font-size: 13px;
}

.variable-catalog__row--header {
  min-height: 40px;
  color: rgb(var(--color-mute));
  font-family: "Space Mono", monospace;
  font-size: 10px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.variable-catalog__row code {
  color: rgb(var(--color-display));
  font-family: "Space Mono", monospace;
  font-size: 12px;
}

.variable-catalog__row--used code { color: rgb(var(--color-success)); }

.variable-catalog__meta {
  color: rgb(var(--color-mute));
  font-family: "Space Mono", monospace;
  font-size: 11px;
}

.variable-catalog__empty {
  padding: 64px 0;
  color: rgb(var(--color-mute));
  text-align: center;
}

@media (max-width: 760px) {
  .variable-catalog { padding: 16px; }
  .variable-catalog__header { align-items: stretch; flex-direction: column; }
  .variable-catalog__search { width: 100%; }
  .variable-catalog__row {
    grid-template-columns: minmax(128px, 1fr) minmax(0, 1.6fr);
    padding: 12px 0;
  }
  .variable-catalog__row > :nth-child(3),
  .variable-catalog__row > :nth-child(4) { display: none; }
}
</style>
