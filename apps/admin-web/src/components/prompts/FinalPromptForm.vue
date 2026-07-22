<script setup lang="ts">
import { computed, shallowRef, watch } from "vue";
import type { PromptVariableDefinition } from "../../types";
import {
  isRecord,
  messageGroupToken,
  parseFinalPromptDocument,
  validateFinalPromptDocument,
  type FinalPromptDocument,
  type FunctionTool,
  type PromptMessage
} from "../../utils/finalPromptDocument";
import FinalPromptMessageSlot from "./FinalPromptMessageSlot.vue";
import FinalPromptWorkspace, { type FinalPromptWorkspaceSection } from "./FinalPromptWorkspace.vue";
import FunctionCallEditor from "./FunctionCallEditor.vue";

const model = defineModel<string>({ required: true });
const props = withDefaults(defineProps<{
  variables: readonly PromptVariableDefinition[];
  semanticXml?: boolean;
  showVariables?: boolean;
}>(), { semanticXml: false, showVariables: true });
const parsed = computed(() => parseFinalPromptDocument(model.value));
const messageGroupVariables = computed(() => props.variables.filter((variable) => variable.type === "message[]"));
const schemaText = shallowRef("");
const schemaError = shallowRef("");
const activeSection = shallowRef("message-0");
const messageSlots = new Map<number, InstanceType<typeof FinalPromptMessageSlot>>();
const validationKind = shallowRef<"" | "success" | "error">("");
const validationMessage = shallowRef("");
const workspaceSections = computed<FinalPromptWorkspaceSection[]>(() => {
  const document = parsed.value.document;
  if (!document) return [];
  return [
    ...document.messages.map((message, index) => ({
      id: `message-${index}`,
      label: typeof message === "string" ? `消息组 ${index + 1}` : `${message.role} 消息`,
      kind: "message" as const,
      index
    })),
    { id: "response", label: "输出格式", kind: "response" as const },
    { id: "tools", label: "Function Call", kind: "tools" as const }
  ];
});

watch(() => parsed.value.document?.response_format, (format) => {
  if (schemaError.value || !format) return;
  const schema = isRecord(format.json_schema) && isRecord(format.json_schema.schema)
    ? format.json_schema.schema
    : {};
  schemaText.value = JSON.stringify(schema, null, 2);
}, { immediate: true, deep: true });

function mutate(update: (document: FinalPromptDocument) => void) {
  const document = parsed.value.document;
  if (!document) return;
  const next = structuredClone(document);
  update(next);
  validationKind.value = "";
  validationMessage.value = "";
  model.value = `${JSON.stringify(next, null, 2)}\n`;
}

function updateMessage(index: number, value: PromptMessage | string) {
  mutate((document) => { document.messages[index] = value; });
}

function addMessage() {
  const index = parsed.value.document?.messages.length ?? 0;
  mutate((document) => { document.messages.push({ role: "user", content: "" }); });
  activeSection.value = `message-${index}`;
}

function addMessageGroup() {
  const variable = messageGroupVariables.value[0];
  if (!variable) return;
  const index = parsed.value.document?.messages.length ?? 0;
  mutate((document) => { document.messages.push(messageGroupToken(variable.name)); });
  activeSection.value = `message-${index}`;
}

function moveMessage(index: number, direction: -1 | 1) {
  reorderMessage(index, index + direction);
}

function reorderMessage(index: number, target: number) {
  const document = parsed.value.document;
  if (!document || target < 0 || target >= document.messages.length) return;
  mutate((next) => {
    const [message] = next.messages.splice(index, 1);
    if (message !== undefined) next.messages.splice(target, 0, message);
  });
  activeSection.value = `message-${target}`;
}

function removeMessage(index: number) {
  mutate((document) => { document.messages.splice(index, 1); });
}

function insertVariable(name: string) {
  const section = workspaceSections.value.find((item) => item.id === activeSection.value);
  if (section?.kind === "message" && typeof section.index === "number") {
    messageSlots.get(section.index)?.insertVariable(name);
  }
}

function setMessageSlot(index: number, instance: unknown) {
  if (instance) messageSlots.set(index, instance as InstanceType<typeof FinalPromptMessageSlot>);
  else messageSlots.delete(index);
}

function testTemplate() {
  const result = validateFinalPromptDocument(model.value, props.variables);
  validationKind.value = result.valid ? "success" : "error";
  validationMessage.value = result.message;
}

function updateTool(index: number, tool: FunctionTool) {
  mutate((document) => {
    const tools = document.tools ?? [];
    tools[index] = tool;
    document.tools = tools;
  });
}

function addTool() {
  mutate((document) => {
    document.tools = [
      ...(document.tools ?? []),
      {
        type: "function",
        function: {
          name: "new_function",
          description: "",
          parameters: { type: "object", additionalProperties: false, properties: {}, required: [] },
          strict: true
        }
      }
    ];
  });
}

function removeTool(index: number) {
  mutate((document) => { document.tools = (document.tools ?? []).filter((_, itemIndex) => itemIndex !== index); });
}

function updateResponseType(type: string) {
  mutate((document) => {
    if (type === "json_schema") {
      document.response_format = isRecord(document.response_format.json_schema)
        ? { ...document.response_format, type }
        : { type, json_schema: { name: "response", strict: true, schema: {} } };
    } else {
      document.response_format = { type };
    }
  });
}

function updateJsonSchemaField(field: "name" | "strict", value: string | boolean) {
  mutate((document) => {
    const jsonSchema = isRecord(document.response_format.json_schema)
      ? document.response_format.json_schema
      : {};
    document.response_format = {
      ...document.response_format,
      json_schema: { ...jsonSchema, [field]: value }
    };
  });
}

function updateSchema(value: string) {
  schemaText.value = value;
  try {
    const schema = JSON.parse(value);
    if (!isRecord(schema)) throw new Error("Schema 必须是 JSON 对象");
    schemaError.value = "";
    mutate((document) => {
      const jsonSchema = isRecord(document.response_format.json_schema)
        ? document.response_format.json_schema
        : {};
      document.response_format = {
        ...document.response_format,
        json_schema: { ...jsonSchema, schema }
      };
    });
  } catch (error) {
    schemaError.value = error instanceof Error ? error.message : "JSON 格式错误";
  }
}

defineExpose({ insertVariable });
</script>

<template>
  <div class="final-form">
    <FinalPromptWorkspace
      v-if="parsed.document"
      v-model="activeSection"
      :sections="workspaceSections"
      @reorder="reorderMessage"
    >
      <template #actions>
        <span
          v-if="validationKind"
          class="final-form__validation inline-state"
          :data-kind="validationKind"
          :title="validationMessage"
        >{{ validationMessage }}</span>
        <button class="btn btn-ghost final-form__toolbar-button" type="button" aria-label="添加普通消息" @click="addMessage">
          <i class="bx bx-plus" aria-hidden="true"></i>
          <span class="final-form__action-label">添加消息</span>
        </button>
        <button
          class="btn btn-ghost final-form__toolbar-button"
          type="button"
          aria-label="添加消息组"
          :disabled="!messageGroupVariables.length"
          @click="addMessageGroup"
        >
          <i class="bx bx-list-plus" aria-hidden="true"></i>
          <span class="final-form__action-label">添加消息组</span>
        </button>
        <button class="btn btn-ghost final-form__toolbar-button" type="button" aria-label="测试 OpenAI 格式" @click="testTemplate">
          <i class="bx bx-test-tube" aria-hidden="true"></i>
          <span class="final-form__action-label">测试</span>
        </button>
      </template>

      <template #default="{ section }">
        <FinalPromptMessageSlot
          v-if="
            section.kind === 'message'
              && parsed.document
              && typeof section.index === 'number'
              && parsed.document.messages[section.index] !== undefined
          "
          :ref="(instance) => setMessageSlot(section.index!, instance)"
          :message="parsed.document.messages[section.index]!"
          :index="section.index"
          :total="parsed.document.messages.length"
          :variables="variables"
          :semantic-xml="semanticXml"
          :show-variables="showVariables"
          @update="updateMessage(section.index, $event)"
          @move="moveMessage(section.index, $event)"
          @remove="removeMessage(section.index)"
        />

        <template v-else-if="section.kind === 'response' && parsed.document">
          <header class="final-form__section-header">
            <h3>{{ section.label }}</h3>
          </header>
          <div class="output-grid">
            <label class="field">
              <span class="field-label">类型</span>
              <select
                class="control"
                :value="String(parsed.document.response_format.type ?? 'text')"
                @change="updateResponseType(($event.target as HTMLSelectElement).value)"
              >
                <option value="text">text</option>
                <option value="json_object">json_object</option>
                <option value="json_schema">json_schema</option>
              </select>
            </label>
            <template v-if="parsed.document.response_format.type === 'json_schema'">
              <label class="field">
                <span class="field-label">Schema 名称</span>
                <input
                  class="control font-mono"
                  :value="
                    isRecord(parsed.document.response_format.json_schema)
                      ? String(parsed.document.response_format.json_schema.name ?? '')
                      : ''
                  "
                  type="text"
                  @input="updateJsonSchemaField('name', ($event.target as HTMLInputElement).value)"
                >
              </label>
              <label class="output-grid__strict">
                <input
                  :checked="
                    isRecord(parsed.document.response_format.json_schema)
                      && parsed.document.response_format.json_schema.strict !== false
                  "
                  type="checkbox"
                  @change="updateJsonSchemaField('strict', ($event.target as HTMLInputElement).checked)"
                >
                <span>严格匹配 Schema</span>
              </label>
              <label class="field">
                <span class="field-label">JSON Schema</span>
                <textarea
                  class="control min-h-64 resize-y py-3 font-mono text-xs leading-5"
                  :value="schemaText"
                  spellcheck="false"
                  @input="updateSchema(($event.target as HTMLTextAreaElement).value)"
                ></textarea>
                <small v-if="schemaError" class="mt-2 text-xs text-accent">{{ schemaError }}</small>
              </label>
            </template>
          </div>
        </template>

        <template v-else-if="section.kind === 'tools' && parsed.document">
          <header class="final-form__section-header">
            <h3>{{ section.label }}</h3>
            <button class="btn btn-ghost" type="button" @click="addTool">
              <i class="bx bx-plus" aria-hidden="true"></i>
              添加 Function
            </button>
          </header>
          <div v-if="parsed.document.tools?.length">
            <FunctionCallEditor
              v-for="(tool, index) in parsed.document.tools"
              :key="index"
              :tool="tool"
              :index="index"
              :variables="variables"
              :semantic-xml="semanticXml"
              @update="updateTool(index, $event)"
              @remove="removeTool(index)"
            />
          </div>
          <p v-else class="final-form__empty">当前请求不启用 Function Call</p>
        </template>
      </template>
    </FinalPromptWorkspace>

    <section v-else class="final-form__invalid">
      <h3>模板无法读取</h3>
      <p>{{ parsed.error }}</p>
      <button class="btn" type="button" @click="testTemplate">测试</button>
    </section>
  </div>
</template>

<style scoped>
.final-form {
  height: 100%;
  min-height: 0;
  min-width: 0;
}

.final-form__section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 18px;
}

.final-form__section-header h3,
.final-form__invalid h3 {
  overflow: hidden;
  color: rgb(var(--color-display));
  font-size: 18px;
  font-weight: 500;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.output-grid {
  display: grid;
  grid-template-columns: 1fr;
  gap: 16px;
}

.output-grid__strict {
  display: flex;
  min-height: 44px;
  align-items: center;
  gap: 10px;
  color: rgb(var(--color-ink));
  font-size: 13px;
}

.final-form__empty {
  border-top: 1px solid rgb(var(--color-line));
  padding-top: 18px;
  color: rgb(var(--color-mute));
  font-size: 13px;
}

.final-form__validation {
  max-width: 240px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.final-form__toolbar-button {
  padding-right: 12px;
  padding-left: 12px;
}

.final-form__invalid {
  display: grid;
  place-content: center;
  height: 100%;
  min-height: 0;
  text-align: center;
}

.final-form__invalid p {
  margin: 12px auto 24px;
  max-width: 520px;
  color: rgb(var(--color-accent));
  font-size: 13px;
}

.final-form__invalid .btn {
  justify-self: center;
}

@container final-prompt (max-width: 720px) {
  .final-form__action-label {
    display: none;
  }

  .final-form__toolbar-button {
    width: 44px;
    padding: 0;
  }

  .final-form__validation {
    max-width: 84px;
  }
}
</style>
