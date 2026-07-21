<script setup lang="ts">
import { computed, shallowRef } from "vue";
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
const referencedVariableCount = computed(() => props.variables.filter((variable) => usageCount(variable.name) > 0).length);
const activeTooltip = shallowRef<{
  id: string;
  variable: PromptVariableDefinition;
  left: number;
  top: number;
  width: number;
  placement: "top" | "bottom";
} | null>(null);

function tooltipId(name: string) {
  return `prompt-variable-${name.replace(/[^a-zA-Z0-9_-]+/g, "-")}-description`;
}

function showVariableTooltip(variable: PromptVariableDefinition, event: Event) {
  const target = event.currentTarget;
  if (!(target instanceof HTMLElement)) return;
  const anchor = target.matches(".variable-context__token")
    ? target
    : target.querySelector<HTMLElement>(".variable-context__token") ?? target;
  const rect = anchor.getBoundingClientRect();
  const width = Math.min(320, Math.max(160, window.innerWidth - 24));
  const left = Math.min(
    window.innerWidth - width - 12,
    Math.max(12, rect.left + rect.width / 2 - width / 2)
  );
  const placement = rect.bottom + 144 <= window.innerHeight ? "bottom" : "top";
  activeTooltip.value = {
    id: tooltipId(variable.name),
    variable,
    left,
    top: placement === "bottom" ? rect.bottom + 8 : rect.top - 8,
    width,
    placement
  };
}

function hideVariableTooltip() {
  activeTooltip.value = null;
}

function insertVariable(name: string) {
  hideVariableTooltip();
  emit("insert", name);
}
</script>

<template>
  <div class="variable-context" :class="{ 'variable-context--fill': fill }" role="table" aria-label="提示词变量表">
    <div class="variable-context__heading">
      <span>可用变量</span>
      <span>已引用 {{ referencedVariableCount }} / {{ variables.length }}</span>
    </div>
    <div v-if="variables.length" class="variable-context__table">
      <button
        v-for="variable in variables"
        :key="variable.name"
        class="variable-context__row"
        :class="{ 'variable-context__row--used': isUsed(variable.name) }"
        type="button"
        :aria-label="`插入 @{${variable.name}}：${variable.description}`"
        :aria-describedby="activeTooltip?.variable.name === variable.name ? activeTooltip.id : undefined"
        @pointerdown.prevent
        @focus="showVariableTooltip(variable, $event)"
        @blur="hideVariableTooltip"
        @keydown.esc.stop="hideVariableTooltip"
        @click="insertVariable(variable.name)"
      >
        <span class="variable-context__primary">
          <span
            class="variable-context__token"
            @pointerenter="showVariableTooltip(variable, $event)"
            @pointerleave="hideVariableTooltip"
          >
            <code>{{ formatVariable(variable.name) }}</code>
          </span>
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

    <Teleport to="body">
      <div
        v-if="activeTooltip"
        :id="activeTooltip.id"
        class="variable-context__tooltip"
        :data-placement="activeTooltip.placement"
        role="tooltip"
        :style="{
          left: `${activeTooltip.left}px`,
          top: `${activeTooltip.top}px`,
          width: `${activeTooltip.width}px`
        }"
      >
        <code>{{ formatVariable(activeTooltip.variable.name) }}</code>
        <p>{{ activeTooltip.variable.description }}</p>
        <small>{{ activeTooltip.variable.type }} · {{ activeTooltip.variable.source }}</small>
      </div>
    </Teleport>
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

.variable-context__row--used .variable-context__token {
  border-color: rgb(var(--color-accent) / 0.56);
  background: rgb(var(--color-accent) / 0.1);
}

.variable-context__row--used code { color: rgb(var(--color-accent)); }

.variable-context__row code {
  overflow: hidden;
  color: rgb(var(--color-display));
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.variable-context__token {
  position: relative;
  display: inline-flex;
  min-width: 0;
  align-items: center;
  padding: 4px 8px;
  border: 1px solid rgb(var(--color-visible));
  border-radius: 7px;
  background: rgb(var(--color-panel));
  transition: border-color 140ms ease, background-color 140ms ease, color 140ms ease;
}

.variable-context__row:hover .variable-context__token,
.variable-context__row:focus-visible .variable-context__token {
  border-color: rgb(var(--color-display));
  background: rgb(var(--color-page));
}

.variable-context__primary,
.variable-context__primary > span,
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

.variable-context__primary code { min-width: 0; flex: 0 1 auto; }

.variable-context__primary > span:not(.variable-context__token) {
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

.variable-context__tooltip {
  position: fixed;
  z-index: 110;
  display: grid;
  gap: 6px;
  padding: 10px 12px;
  border: 1px solid rgb(var(--color-visible));
  border-radius: 8px;
  background: rgb(var(--color-display));
  color: rgb(var(--color-page));
  box-shadow: 0 10px 28px rgb(0 0 0 / 0.2);
  pointer-events: none;
}

.variable-context__tooltip[data-placement="top"] { transform: translateY(-100%); }

.variable-context__tooltip code {
  overflow-wrap: anywhere;
  font-family: "Space Mono", monospace;
  font-size: 11px;
  color: inherit;
}

.variable-context__tooltip p {
  font-size: 12px;
  line-height: 1.55;
}

.variable-context__tooltip small {
  font-family: "Space Mono", monospace;
  font-size: 9px;
  color: rgb(var(--color-page) / 0.68);
}

@container (max-width: 280px) {
  .variable-context__primary { align-items: flex-start; flex-direction: column; gap: 3px; }
}
</style>
