<script setup lang="ts">
import { computed, shallowRef, useTemplateRef, watch } from "vue";
import type { AgentFileDetail } from "../../types";
import { promptVariableUsageCounts, usedPromptVariableNames } from "../../utils/promptVariables";
import FinalPromptForm from "./FinalPromptForm.vue";
import PromptTextField from "./PromptTextField.vue";
import PromptVariableTable from "./PromptVariableTable.vue";
import DialogOverlay from "../ui/DialogOverlay.vue";

const content = defineModel<string>({ required: true });
const props = defineProps<{
  file: AgentFileDetail | null;
  loading: boolean;
  dirty: boolean;
  saving: boolean;
  message: string;
  messageKind: string;
  conflict: boolean;
}>();
const emit = defineEmits<{ save: []; discard: []; back: []; loadServer: []; keepLocal: [] }>();
const lines = computed(() => (content.value ? content.value.split("\n").length : 1));
const characters = computed(() => content.value.length);
const variableDrawerOpen = shallowRef(false);
const variablePanelWidth = shallowRef(336);
const semanticXml = shallowRef(false);
const usedNames = computed(() => usedPromptVariableNames(content.value, props.file?.variables ?? []));
const usageCounts = computed(() => promptVariableUsageCounts(content.value, props.file?.variables ?? []));
const workspaceStyle = computed(() => ({ "--variable-panel-width": `${variablePanelWidth.value}px` }));
const promptTextField = useTemplateRef<InstanceType<typeof PromptTextField>>("promptTextField");
const finalPromptForm = useTemplateRef<InstanceType<typeof FinalPromptForm>>("finalPromptForm");
watch(() => props.file?.id, () => { variableDrawerOpen.value = false; });

function insertVariable(name: string) {
  if (props.file?.kind === "final") finalPromptForm.value?.insertVariable(name);
  else promptTextField.value?.insertVariable(name);
  variableDrawerOpen.value = false;
}

function resizeVariablePanel(clientX: number, target: HTMLElement) {
  const workspace = target.parentElement;
  if (!workspace) return;
  const rect = workspace.getBoundingClientRect();
  const maximum = Math.min(480, Math.max(264, rect.width - 480));
  variablePanelWidth.value = Math.round(Math.min(maximum, Math.max(264, rect.right - clientX - target.offsetWidth / 2)));
}

function startVariableResize(event: PointerEvent) {
  const target = event.currentTarget as HTMLElement;
  target.setPointerCapture(event.pointerId);
  resizeVariablePanel(event.clientX, target);
}

function moveVariableResize(event: PointerEvent) {
  const target = event.currentTarget as HTMLElement;
  if (target.hasPointerCapture(event.pointerId)) resizeVariablePanel(event.clientX, target);
}

function resizeVariablePanelWithKeyboard(event: KeyboardEvent) {
  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
  event.preventDefault();
  const direction = event.key === "ArrowLeft" ? 1 : -1;
  variablePanelWidth.value = Math.min(480, Math.max(264, variablePanelWidth.value + direction * 16));
}

function resetVariablePanelWidth() {
  variablePanelWidth.value = 336;
}
</script>

<template>
  <section class="prompt-editor flex h-full min-h-0 min-w-0 flex-col bg-page">
    <header class="flex min-h-20 flex-wrap items-center gap-3 border-b border-line px-4 py-3 md:px-6">
      <button class="icon-btn lg:hidden" type="button" aria-label="返回文件列表" @click="emit('back')">
        <i class="bx bx-left-arrow-alt text-xl" aria-hidden="true"></i>
      </button>
      <div class="min-w-0 flex-1">
        <h2 class="truncate text-2xl font-medium tracking-[-0.02em] text-display">{{ file?.title ?? "选择提示词文件" }}</h2>
      </div>
      <div v-if="file" class="flex w-full min-w-0 items-center gap-2 sm:w-auto">
        <button class="variable-drawer-trigger btn btn-ghost min-w-0 flex-1 sm:flex-none" type="button" @click="variableDrawerOpen = true"><i class="bx bx-table" aria-hidden="true"></i>变量表</button>
        <button class="btn btn-ghost px-3" :class="semanticXml ? '!border-success !text-success' : ''" type="button" :aria-pressed="semanticXml" title="插入变量时自动添加 XML 标签" aria-label="XML 包装" @click="semanticXml = !semanticXml">
          <i class="bx bx-code-alt" aria-hidden="true"></i>
          <span class="hidden xl:inline">XML 包装</span>
        </button>
        <button class="icon-btn" type="button" :disabled="!dirty || saving" title="放弃修改" aria-label="放弃修改" @click="emit('discard')">
          <i class="bx bx-reset text-xl" aria-hidden="true"></i>
        </button>
        <button class="btn btn-primary px-3 sm:px-4" type="button" :disabled="!dirty || saving" @click="emit('save')">
          <i class="bx bx-save" aria-hidden="true"></i>
          {{ saving ? "保存中" : "保存" }}
        </button>
      </div>
    </header>

    <div v-if="loading" class="empty-state flex-1"><div><strong>正在读取提示词</strong></div></div>
    <div v-else-if="!file" class="empty-state flex-1 dot-grid">
      <div class="bg-page px-5 py-3">
        <strong :class="message ? '!text-accent' : ''">{{ message || "选择一个提示词" }}</strong>
      </div>
    </div>
    <div v-else class="flex min-h-0 flex-1 flex-col p-3 md:p-6">
      <div class="prompt-editor__workspace min-h-0 flex-1" :style="workspaceStyle">
        <div v-if="file.kind === 'final'" class="min-h-0 overflow-hidden">
          <FinalPromptForm ref="finalPromptForm" v-model="content" :variables="file.variables ?? []" :semantic-xml="semanticXml" :show-variables="false" />
        </div>
        <PromptTextField
          v-else
          ref="promptTextField"
          v-model="content"
          :variables="file.variables ?? []"
          label="提示词正文"
          min-height="240px"
          fill
          :show-variables="false"
          :semantic-xml="semanticXml"
        />
        <PromptVariableTable
          class="prompt-editor__variables min-h-0"
          :variables="file.variables ?? []"
          :used-names="usedNames"
          :usage-counts="usageCounts"
          fill
          @insert="insertVariable"
        />
        <div
          class="prompt-editor__splitter"
          role="separator"
          aria-label="调整可用变量宽度"
          aria-orientation="vertical"
          :aria-valuenow="variablePanelWidth"
          aria-valuemin="264"
          aria-valuemax="480"
          tabindex="0"
          @pointerdown="startVariableResize"
          @pointermove="moveVariableResize"
          @keydown="resizeVariablePanelWithKeyboard"
          @dblclick="resetVariablePanelWidth"
        ></div>
      </div>

      <div
        v-if="conflict"
        class="mt-3 flex flex-wrap items-center justify-between gap-3 border-y border-accent py-3"
        role="alert"
        aria-label="版本冲突"
      >
        <div class="min-w-0">
          <strong class="block text-sm font-medium text-accent">服务器版本已更新</strong>
          <p class="mt-1 text-xs leading-5 text-mute">保留当前内容后可再次保存，或加载服务器版本并放弃当前修改。</p>
        </div>
        <div class="flex gap-2">
          <button class="btn btn-ghost" type="button" @click="emit('keepLocal')">保留当前内容</button>
          <button class="btn" type="button" @click="emit('loadServer')">加载服务器版本</button>
        </div>
      </div>

      <footer class="mt-3 flex flex-wrap items-center justify-between gap-2 font-mono text-[10px] text-mute">
        <span>{{ file.fileName }}</span>
        <span class="inline-state" :data-kind="messageKind || undefined">{{ message || (dirty ? "未保存" : "已同步") }}</span>
        <span>{{ lines }} 行 · {{ characters }} 字符 · ⌘/Ctrl + S</span>
      </footer>
    </div>

    <DialogOverlay :open="variableDrawerOpen" placement="right" labelledby="prompt-variable-drawer-title" @close="variableDrawerOpen = false">
      <aside class="flex h-full w-[min(92vw,420px)] flex-col border-l border-visible bg-panel">
        <header class="flex items-center justify-between border-b border-line px-4 py-3">
          <h3 id="prompt-variable-drawer-title" class="text-base font-medium text-display">变量表</h3>
          <button class="icon-btn" type="button" aria-label="关闭变量表" @click="variableDrawerOpen = false"><i class="bx bx-x text-xl" aria-hidden="true"></i></button>
        </header>
        <PromptVariableTable
          class="min-h-0 flex-1"
          :variables="file?.variables ?? []"
          :used-names="usedNames"
          :usage-counts="usageCounts"
          fill
          @insert="insertVariable"
        />
      </aside>
    </DialogOverlay>
  </section>
</template>

<style scoped>
.prompt-editor { container-type: inline-size; }

.prompt-editor__workspace {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
}

.prompt-editor__variables { display: none; }
.prompt-editor__splitter { display: none; }

@container (min-width: 640px) {
  .prompt-editor .prompt-editor__workspace {
    grid-template-rows: minmax(0, 1fr) minmax(144px, 28%);
    gap: 12px;
    overflow: hidden;
  }

  .prompt-editor .prompt-editor__variables {
    display: flex;
    min-height: 0;
    overflow: hidden;
    border: 1px solid rgb(var(--color-visible));
    border-radius: 8px;
  }

  .prompt-editor .variable-drawer-trigger { display: none; }
}

@container (min-width: 960px) {
  .prompt-editor .prompt-editor__workspace {
    grid-template-areas: "editor splitter variables";
    grid-template-columns: minmax(0, 1fr) 16px var(--variable-panel-width);
    grid-template-rows: minmax(0, 1fr);
    gap: 0;
    overflow: hidden;
    background: transparent;
  }

  .prompt-editor .prompt-editor__workspace > :first-child { grid-area: editor; }
  .prompt-editor .prompt-editor__variables {
    grid-area: variables;
    display: flex;
    overflow: hidden;
  }
  .prompt-editor .prompt-editor__splitter {
    z-index: 5;
    grid-area: splitter;
    display: grid;
    width: 16px;
    place-items: center;
    cursor: col-resize;
    touch-action: none;
  }

  .prompt-editor .prompt-editor__splitter::before {
    width: 10px;
    height: 64px;
    border: 1px solid rgb(var(--color-visible));
    border-radius: 999px;
    background: rgb(var(--color-panel));
    content: "";
    transition: border-color 140ms ease, background-color 140ms ease;
  }

  .prompt-editor .prompt-editor__splitter::after {
    position: absolute;
    width: 2px;
    height: 18px;
    background: radial-gradient(circle, rgb(var(--color-mute)) 1px, transparent 1.5px) center / 2px 6px;
    content: "";
    transition: background-image 140ms ease;
  }

  .prompt-editor .prompt-editor__splitter:hover::before,
  .prompt-editor .prompt-editor__splitter:focus-visible::before {
    border-color: rgb(var(--color-accent));
    background: rgb(var(--color-accent) / 0.08);
  }

  .prompt-editor .prompt-editor__splitter:hover::after,
  .prompt-editor .prompt-editor__splitter:focus-visible::after {
    background-image: radial-gradient(circle, rgb(var(--color-accent)) 1px, transparent 1.5px);
  }

  .prompt-editor .prompt-editor__splitter:focus-visible {
    outline: 0;
  }
}
</style>
