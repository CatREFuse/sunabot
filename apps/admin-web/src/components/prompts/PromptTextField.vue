<script setup lang="ts">
import { Compartment, EditorState, Transaction } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { computed, onBeforeUnmount, onMounted, shallowRef, useTemplateRef, watch } from "vue";
import type { PromptVariableDefinition } from "../../types";
import { usedPromptVariableNames } from "../../utils/promptVariables";
import PromptVariableTable from "./PromptVariableTable.vue";
import {
  promptEditorAttributes,
  promptEditorBaseExtensions,
  promptVariableExtensions,
  promptVariableToken
} from "./promptCodeMirror";

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

const editorHost = useTemplateRef<HTMLDivElement>("editorHost");
const editor = shallowRef<EditorView | null>(null);
const attributesCompartment = new Compartment();
const variablesCompartment = new Compartment();
const usedNames = computed(() => usedPromptVariableNames(model.value, props.variables));

onMounted(() => {
  if (!editorHost.value) return;
  const state = EditorState.create({
    doc: model.value,
    extensions: [
      ...promptEditorBaseExtensions,
      attributesCompartment.of(promptEditorAttributes(props.label)),
      variablesCompartment.of(promptVariableExtensions(props.variables, props.semanticXml)),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) model.value = update.state.doc.toString();
      })
    ]
  });
  editor.value = new EditorView({ state, parent: editorHost.value });
});

watch(model, (value) => {
  const view = editor.value;
  if (!view || view.state.doc.toString() === value) return;
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: value },
    selection: { anchor: Math.min(view.state.selection.main.head, value.length) },
    annotations: Transaction.addToHistory.of(false)
  });
});

watch(() => props.label, (label) => {
  editor.value?.dispatch({ effects: attributesCompartment.reconfigure(promptEditorAttributes(label)) });
});

watch([() => props.variables, () => props.semanticXml], () => {
  editor.value?.dispatch({
    effects: variablesCompartment.reconfigure(promptVariableExtensions(props.variables, props.semanticXml))
  });
});

onBeforeUnmount(() => {
  editor.value?.destroy();
  editor.value = null;
});

function insertVariable(name: string) {
  const view = editor.value;
  if (!view) return;
  const selection = view.state.selection.main;
  const token = promptVariableToken(name, props.semanticXml);
  view.dispatch({
    changes: { from: selection.from, to: selection.to, insert: token },
    selection: { anchor: selection.from + token.length }
  });
  view.focus();
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
    :style="{ '--prompt-editor-min-height': minHeight }"
  >
    <div class="prompt-field__editor">
      <div ref="editorHost" class="prompt-field__codemirror"></div>
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

.prompt-field__editor {
  position: relative;
  height: var(--prompt-editor-min-height);
  min-width: 0;
  min-height: var(--prompt-editor-min-height);
  overflow: hidden;
  flex: 1;
  resize: vertical;
}

.prompt-field__codemirror {
  height: 100%;
  min-height: 0;
}

.prompt-field--fill .prompt-field__editor {
  height: auto;
  min-height: 0;
  resize: none;
}

@media (max-width: 720px) {
  .prompt-field__editor {
    min-height: max(160px, var(--prompt-editor-min-height));
  }
}
</style>
