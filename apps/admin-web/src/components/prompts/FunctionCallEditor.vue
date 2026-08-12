<script setup lang="ts">
import { computed, shallowRef, watch } from "vue";
import type { PromptVariableDefinition } from "../../types";
import PromptTextField from "./PromptTextField.vue";

interface FunctionTool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    strict?: boolean;
  };
}

const props = withDefaults(defineProps<{
  tool: FunctionTool;
  index: number;
  variables?: readonly PromptVariableDefinition[];
  semanticXml?: boolean;
}>(), { variables: () => [], semanticXml: false });
const emit = defineEmits<{ update: [tool: FunctionTool]; remove: [] }>();
const parametersText = shallowRef(JSON.stringify(props.tool.function.parameters, null, 2));
const parametersError = shallowRef("");
const identity = computed(() => `${props.tool.function.name}:${JSON.stringify(props.tool.function.parameters)}`);

watch(identity, () => {
  if (parametersError.value) return;
  parametersText.value = JSON.stringify(props.tool.function.parameters, null, 2);
});

function updateFunction(field: "name" | "description" | "strict", value: string | boolean) {
  emit("update", {
    ...props.tool,
    function: { ...props.tool.function, [field]: value }
  });
}

function updateParameters(value: string) {
  parametersText.value = value;
  try {
    const parameters = JSON.parse(value);
    if (!parameters || typeof parameters !== "object" || Array.isArray(parameters)) throw new Error("必须是 JSON 对象");
    parametersError.value = "";
    emit("update", { ...props.tool, function: { ...props.tool.function, parameters } });
  } catch (error) {
    parametersError.value = error instanceof Error ? error.message : "JSON 格式错误";
  }
}
</script>

<template>
  <section class="function-editor">
    <header class="function-editor__header">
      <div>
        <span>Function {{ index + 1 }}</span>
        <strong>{{ tool.function.name || "未命名 Function" }}</strong>
      </div>
      <button class="icon-btn" type="button" :aria-label="`删除 ${tool.function.name || 'Function Call'}`" @click="emit('remove')">
        <i class="bx bx-trash text-lg" aria-hidden="true"></i>
      </button>
    </header>
    <div class="function-editor__grid">
      <label class="field">
        <span class="field-label">名称</span>
        <input class="control font-mono" :value="tool.function.name" type="text" @input="updateFunction('name', ($event.target as HTMLInputElement).value)">
      </label>
      <div class="field function-editor__wide">
        <span class="field-label">提示词内说明</span>
        <PromptTextField
          :model-value="tool.function.description"
          :variables="variables"
          :label="`${tool.function.name || 'Function'} 工具说明`"
          min-height="96px"
          :show-variables="false"
          :semantic-xml="semanticXml"
          @update:model-value="updateFunction('description', $event)"
        />
      </div>
      <label class="field function-editor__wide">
        <span class="field-label">参数 · JSON Schema</span>
        <textarea class="control min-h-56 resize-y py-3 font-mono text-xs leading-5" :value="parametersText" spellcheck="false" @input="updateParameters(($event.target as HTMLTextAreaElement).value)"></textarea>
        <small v-if="parametersError" class="mt-2 text-xs text-accent">{{ parametersError }}</small>
      </label>
      <label class="function-editor__strict">
        <input :checked="tool.function.strict !== false" type="checkbox" @change="updateFunction('strict', ($event.target as HTMLInputElement).checked)">
        <span>严格校验参数</span>
      </label>
    </div>
  </section>
</template>

<style scoped>
.function-editor {
  border-top: 1px solid rgb(var(--color-line));
  padding: 20px 0;
}

.function-editor:first-child {
  border-top: 0;
  padding-top: 0;
}

.function-editor__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 16px;
}

.function-editor__header div {
  min-width: 0;
}

.function-editor__header span {
  display: block;
  font-family: "Space Mono", monospace;
  font-size: 10px;
  letter-spacing: 0.08em;
  color: rgb(var(--color-mute));
}

.function-editor__header strong {
  display: block;
  overflow: hidden;
  margin-top: 4px;
  color: rgb(var(--color-display));
  font-size: 14px;
  font-weight: 500;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.function-editor__grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(168px, 0.42fr);
  gap: 16px 24px;
}

.function-editor__wide {
  grid-column: 1 / -1;
}

.function-editor__strict {
  display: flex;
  min-height: 44px;
  align-items: center;
  gap: 10px;
  color: rgb(var(--color-ink));
  font-size: 13px;
}

@media (max-width: 720px) {
  .function-editor__grid {
    grid-template-columns: 1fr;
  }

  .function-editor__wide {
    grid-column: auto;
  }
}
</style>
