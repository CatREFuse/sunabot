<script setup lang="ts">
import { computed, nextTick, shallowRef, useTemplateRef } from "vue";
import type { PromptVariableDefinition } from "../../types";
import { usedPromptVariableNames } from "../../utils/promptVariables";
import { highlightedPromptMarkup } from "../../utils/promptMarkupHighlight";
import PromptVariableTable from "./PromptVariableTable.vue";

const model = defineModel<string>({ required: true });
const props = withDefaults(defineProps<{
  variables: readonly PromptVariableDefinition[];
  label: string;
  minHeight?: string;
  fill?: boolean;
  showVariables?: boolean;
  semanticXml?: boolean;
}>(), {
  minHeight: "160px",
  fill: false,
  showVariables: true,
  semanticXml: false
});

const textarea = useTemplateRef<HTMLTextAreaElement>("textarea");
const highlightLayer = useTemplateRef<HTMLElement>("highlightLayer");
const query = shallowRef("");
const replaceStart = shallowRef(-1);
const activeIndex = shallowRef(0);
const suggestions = computed(() => {
  const term = query.value.trim().toLocaleLowerCase();
  const matches = term
    ? props.variables.filter((item) => `${item.name} ${item.description}`.toLocaleLowerCase().includes(term))
    : props.variables;
  return matches.slice(0, 8);
});
const suggestionsOpen = computed(() => replaceStart.value >= 0 && suggestions.value.length > 0);
const usedNames = computed(() => usedPromptVariableNames(model.value, props.variables));
const variableNames = computed(() => new Set(props.variables.map((variable) => variable.name)));
const highlightedContent = computed(() => `${highlightedPromptMarkup(model.value, variableNames.value)}\n`);
const formatVariable = (name: string) => `@{${name}}`;

function variableToken(name: string) {
  const token = formatVariable(name);
  if (!props.semanticXml) return token;
  const normalized = name.replace(/[^A-Za-z0-9_-]+/g, "_");
  const tag = /^[A-Za-z_]/.test(normalized) ? normalized : `variable_${normalized}`;
  return `<${tag}>${token}</${tag}>`;
}

function onInput(event: Event) {
  model.value = (event.target as HTMLTextAreaElement).value;
  updateSuggestions(event.target as HTMLTextAreaElement);
  syncHighlightScroll(event.target as HTMLTextAreaElement);
}

function updateSuggestions(target = textarea.value) {
  if (!target) return closeSuggestions();
  const cursor = target.selectionStart;
  const before = target.value.slice(0, cursor);
  const lineStart = before.lastIndexOf("\n") + 1;
  const at = before.lastIndexOf("@");
  if (at < lineStart || before[at + 1] === "{" || /[}\n]/.test(before.slice(at + 1))) {
    closeSuggestions();
    return;
  }
  replaceStart.value = at;
  query.value = before.slice(at + 1);
  activeIndex.value = 0;
}

function onKeydown(event: KeyboardEvent) {
  if (suggestionsOpen.value) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const direction = event.key === "ArrowDown" ? 1 : -1;
      activeIndex.value = (activeIndex.value + direction + suggestions.value.length) % suggestions.value.length;
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const selected = suggestions.value[activeIndex.value];
      if (selected) insertVariable(selected.name);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      closeSuggestions();
      return;
    }
  }
  if (event.key === "Tab") {
    event.preventDefault();
    insertText("  ");
  }
}

function insertVariable(name: string) {
  const target = textarea.value;
  if (!target) return;
  const scrollTop = target.scrollTop;
  const scrollLeft = target.scrollLeft;
  const start = replaceStart.value >= 0 ? replaceStart.value : target.selectionStart;
  const end = target.selectionStart;
  const token = variableToken(name);
  model.value = `${model.value.slice(0, start)}${token}${model.value.slice(end)}`;
  closeSuggestions();
  void focusAt(start + token.length, scrollTop, scrollLeft);
}

function insertText(text: string) {
  const target = textarea.value;
  if (!target) return;
  const start = target.selectionStart;
  const end = target.selectionEnd;
  model.value = `${model.value.slice(0, start)}${text}${model.value.slice(end)}`;
  void focusAt(start + text.length);
}

async function focusAt(position: number, scrollTop?: number, scrollLeft?: number) {
  await nextTick();
  const target = textarea.value;
  if (!target) return;
  target.focus({ preventScroll: true });
  target.setSelectionRange(position, position);
  if (scrollTop !== undefined) target.scrollTop = scrollTop;
  if (scrollLeft !== undefined) target.scrollLeft = scrollLeft;
  syncHighlightScroll(target);
}

function closeSuggestions() {
  replaceStart.value = -1;
  query.value = "";
  activeIndex.value = 0;
}

function onBlur() {
  window.setTimeout(closeSuggestions, 120);
}

function syncHighlightScroll(target = textarea.value) {
  if (!target || !highlightLayer.value) return;
  highlightLayer.value.scrollTop = target.scrollTop;
  highlightLayer.value.scrollLeft = target.scrollLeft;
}

defineExpose({ insertVariable });
</script>

<template>
  <div
    class="prompt-field"
    :class="{
      'prompt-field--fill': fill,
      'prompt-field--with-variables': showVariables
    }"
  >
    <div class="prompt-field__editor">
      <pre ref="highlightLayer" class="prompt-field__highlight" aria-hidden="true" v-html="highlightedContent"></pre>
      <textarea
        ref="textarea"
        :value="model"
        class="prompt-field__textarea"
        :style="{ minHeight }"
        spellcheck="false"
        :aria-label="label"
        @input="onInput"
        @click="updateSuggestions()"
        @keyup="updateSuggestions()"
        @keydown="onKeydown"
        @scroll="syncHighlightScroll()"
        @blur="onBlur"
      ></textarea>
      <div v-if="suggestionsOpen" class="prompt-field__suggestions" role="listbox" :aria-label="`${label}变量`">
        <button
          v-for="(variable, index) in suggestions"
          :key="variable.name"
          class="prompt-field__suggestion"
          :class="{ 'prompt-field__suggestion--active': index === activeIndex }"
          type="button"
          role="option"
          :aria-selected="index === activeIndex"
          @mousedown.prevent="insertVariable(variable.name)"
        >
          <code>{{ formatVariable(variable.name) }}</code>
          <span>{{ variable.description }}</span>
        </button>
      </div>
    </div>
    <PromptVariableTable v-if="showVariables" :variables="variables" :used-names="usedNames" :fill="fill" @insert="insertVariable" />
  </div>
</template>

<style scoped>
.prompt-field {
  position: relative;
  overflow: visible;
  border: 1px solid rgb(var(--color-visible));
  border-radius: 4px;
  background: rgb(var(--color-panel));
}

.prompt-field--fill .prompt-field__editor,
.prompt-field--fill .prompt-field__textarea,
.prompt-field--fill .prompt-field__highlight {
  min-height: 0;
}

.prompt-field--fill {
  display: flex;
  min-height: 0;
  flex: 1;
  flex-direction: column;
}

.prompt-field--fill.prompt-field--with-variables {
  display: grid;
  grid-template-rows: minmax(180px, 3fr) minmax(160px, 2fr);
}

.prompt-field--fill .prompt-field__editor {
  display: flex;
  overflow: hidden;
}

.prompt-field--fill .prompt-field__textarea { resize: none; }

.prompt-field--fill .prompt-field__textarea,
.prompt-field--fill .prompt-field__highlight { height: 100%; }

.prompt-field--fill .prompt-field__textarea { flex: 1; }

.prompt-field__editor {
  position: relative;
  min-width: 0;
  flex: 1;
}

.prompt-field__highlight,
.prompt-field__textarea {
  margin: 0;
  padding: 20px 24px;
  font-family: "Space Mono", monospace;
  font-size: 13px;
  font-variant-ligatures: none;
  line-height: 1.6;
  tab-size: 2;
  white-space: pre-wrap;
  overflow-wrap: break-word;
}

.prompt-field__highlight {
  position: absolute;
  z-index: 0;
  inset: 0;
  overflow: auto;
  border-radius: 4px;
  color: rgb(var(--color-ink));
  pointer-events: none;
  scrollbar-width: none;
}

.prompt-field__highlight::-webkit-scrollbar { display: none; }

.prompt-field__textarea {
  position: relative;
  z-index: 1;
  display: block;
  width: 100%;
  resize: vertical;
  border: 0;
  border-radius: 4px 4px 0 0;
  background: transparent;
  color: transparent;
  caret-color: rgb(var(--color-accent));
  -webkit-text-fill-color: transparent;
  outline: none;
}

.prompt-field__textarea::selection {
  background: rgb(var(--color-accent) / 0.18);
  color: rgb(var(--color-display));
  -webkit-text-fill-color: rgb(var(--color-display));
  -webkit-text-stroke: 0 transparent;
  text-shadow: none;
}

.prompt-field__textarea:focus {
  outline: 1px solid rgb(var(--color-display));
  outline-offset: -1px;
}

.prompt-field__highlight :deep(.markup-heading),
.prompt-field__highlight :deep(.markup-bold) {
  font-weight: inherit;
  text-shadow: 0.25px 0 currentColor, -0.25px 0 currentColor;
}
.prompt-field__highlight :deep(.markup-italic),
.prompt-field__highlight :deep(.markup-quote) { font-style: inherit; }
.prompt-field__highlight :deep(.markup-marker),
.prompt-field__highlight :deep(.markup-list-marker),
.prompt-field__highlight :deep(.markup-xml),
.prompt-field__highlight :deep(.markup-variable) { color: rgb(var(--color-accent)); }
.prompt-field__highlight :deep(.markup-code) {
  background: rgb(var(--color-accent) / 0.08);
  color: rgb(var(--color-accent));
}
.prompt-field__highlight :deep(.markup-code-block) {
  background: rgb(var(--color-accent) / 0.08);
  color: rgb(var(--color-ink));
}
.prompt-field__highlight :deep(.markup-code-fence) { color: rgb(var(--color-accent)); }
.prompt-field__highlight :deep(.markup-quote) { color: rgb(var(--color-mute)); }

.prompt-field__suggestions {
  position: absolute;
  z-index: 30;
  right: 12px;
  bottom: 12px;
  left: 12px;
  max-height: 288px;
  overflow-y: auto;
  border: 1px solid rgb(var(--color-visible));
  border-radius: 4px;
  background: rgb(var(--color-panel));
}

.prompt-field__suggestion {
  display: grid;
  width: 100%;
  min-height: 44px;
  grid-template-columns: minmax(136px, 0.8fr) minmax(180px, 1.4fr);
  align-items: center;
  gap: 12px;
  border-bottom: 1px solid rgb(var(--color-line));
  padding: 8px 12px;
  text-align: left;
}

.prompt-field__suggestion:last-child {
  border-bottom: 0;
}

.prompt-field__suggestion--active {
  background: rgb(var(--color-raised));
}

.prompt-field__suggestion code {
  overflow: hidden;
  color: rgb(var(--color-display));
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.prompt-field__suggestion span {
  color: rgb(var(--color-mute));
  font-size: 12px;
}
</style>
