<script setup lang="ts">
import { computed, nextTick, shallowRef, useTemplateRef } from "vue";
import type { PromptVariableDefinition } from "../../types";
import PromptVariableTable from "./PromptVariableTable.vue";

const model = defineModel<string>({ required: true });
const props = withDefaults(defineProps<{
  variables: readonly PromptVariableDefinition[];
  label: string;
  minHeight?: string;
  fill?: boolean;
  showVariables?: boolean;
}>(), {
  minHeight: "160px",
  fill: false,
  showVariables: true
});

const textarea = useTemplateRef<HTMLTextAreaElement>("textarea");
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
const formatVariable = (name: string) => `@{${name}}`;

function onInput(event: Event) {
  model.value = (event.target as HTMLTextAreaElement).value;
  updateSuggestions(event.target as HTMLTextAreaElement);
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
  const start = replaceStart.value >= 0 ? replaceStart.value : target.selectionStart;
  const end = target.selectionStart;
  const token = `@{${name}}`;
  model.value = `${model.value.slice(0, start)}${token}${model.value.slice(end)}`;
  closeSuggestions();
  void focusAt(start + token.length);
}

function insertText(text: string) {
  const target = textarea.value;
  if (!target) return;
  const start = target.selectionStart;
  const end = target.selectionEnd;
  model.value = `${model.value.slice(0, start)}${text}${model.value.slice(end)}`;
  void focusAt(start + text.length);
}

async function focusAt(position: number) {
  await nextTick();
  textarea.value?.focus();
  textarea.value?.setSelectionRange(position, position);
}

function closeSuggestions() {
  replaceStart.value = -1;
  query.value = "";
  activeIndex.value = 0;
}

function onBlur() {
  window.setTimeout(closeSuggestions, 120);
}
</script>

<template>
  <div class="prompt-field" :class="{ 'prompt-field--fill': fill }">
    <div class="prompt-field__editor">
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
    <PromptVariableTable v-if="showVariables" :variables="variables" @insert="insertVariable" />
  </div>
</template>

<style scoped>
.prompt-field {
  position: relative;
  overflow: visible;
  border: 1px solid rgb(var(--color-visible));
  border-radius: 8px;
  background: rgb(var(--color-panel));
}

.prompt-field--fill,
.prompt-field--fill .prompt-field__editor,
.prompt-field--fill .prompt-field__textarea {
  min-height: 0;
  flex: 1;
}

.prompt-field--fill {
  display: flex;
  flex-direction: column;
}

.prompt-field--fill .prompt-field__editor {
  display: flex;
}

.prompt-field__editor {
  position: relative;
}

.prompt-field__textarea {
  display: block;
  width: 100%;
  resize: vertical;
  border: 0;
  border-radius: 8px 8px 0 0;
  background: transparent;
  padding: 16px;
  font-family: "Space Mono", monospace;
  font-size: 13px;
  line-height: 1.6;
  color: rgb(var(--color-ink));
  outline: none;
}

.prompt-field__textarea:focus {
  box-shadow: inset 0 0 0 1px rgb(var(--color-display));
}

.prompt-field__suggestions {
  position: absolute;
  z-index: 30;
  right: 12px;
  bottom: 12px;
  left: 12px;
  max-height: 288px;
  overflow-y: auto;
  border: 1px solid rgb(var(--color-visible));
  border-radius: 8px;
  background: rgb(var(--color-panel));
  box-shadow: 0 16px 40px rgb(0 0 0 / 0.18);
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
