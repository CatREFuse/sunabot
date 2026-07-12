<script setup lang="ts">
import { computed, shallowRef, watch } from "vue";
import type { AgentFileDetail } from "../../types";
import { usedPromptVariableNames } from "../../utils/promptVariables";
import FinalPromptForm from "./FinalPromptForm.vue";
import PromptTextField from "./PromptTextField.vue";
import PromptVariableCatalog from "./PromptVariableCatalog.vue";

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
const activeTab = shallowRef<"editor" | "variables">("editor");
const semanticXml = shallowRef(false);
const usedNames = computed(() => usedPromptVariableNames(content.value, props.file?.variables ?? []));
watch(() => props.file?.id, () => { activeTab.value = "editor"; });
</script>

<template>
  <section class="flex h-full min-h-0 min-w-0 flex-col bg-page">
    <header class="flex min-h-20 flex-wrap items-center gap-3 border-b border-line px-4 py-3 md:px-6">
      <button class="icon-btn lg:hidden" type="button" aria-label="返回文件列表" @click="emit('back')">
        <i class="bx bx-left-arrow-alt text-xl" aria-hidden="true"></i>
      </button>
      <div class="min-w-0 flex-1">
        <p class="font-mono text-[10px] uppercase tracking-[0.08em] text-mute">{{ file ? `${file.kind === "final" ? "FINAL JSON" : "MD FRAGMENT"} · ${file.category}` : "PROMPT" }}</p>
        <h2 class="truncate text-lg font-medium text-display">{{ file?.title ?? "选择提示词文件" }}</h2>
      </div>
      <div v-if="file" class="flex w-full min-w-0 items-center gap-2 sm:w-auto">
        <div class="segmented min-w-0 flex-1 sm:flex-none" aria-label="提示词视图">
          <button class="segmented-button flex-1 sm:flex-none" type="button" :aria-pressed="activeTab === 'editor'" @click="activeTab = 'editor'">编辑器</button>
          <button class="segmented-button flex-1 sm:flex-none" type="button" :aria-pressed="activeTab === 'variables'" @click="activeTab = 'variables'">变量表</button>
        </div>
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

    <div v-if="loading" class="empty-state flex-1"><div><strong>[LOADING...]</strong><p>正在读取正文</p></div></div>
    <div v-else-if="!file" class="empty-state flex-1 dot-grid">
      <div class="bg-page px-5 py-3">
        <strong :class="message ? '!text-accent' : ''">{{ message || "选择一个提示词文件" }}</strong>
        <p v-if="!message">选择后打开正文</p>
      </div>
    </div>
    <PromptVariableCatalog v-else-if="activeTab === 'variables'" :variables="file.variables ?? []" :used-names="usedNames" class="min-h-0 flex-1" />
    <div v-else class="flex min-h-0 flex-1 flex-col p-3 md:p-6">
      <div v-if="file.kind === 'final'" class="min-h-0 flex-1 overflow-hidden">
        <FinalPromptForm v-model="content" :variables="file.variables ?? []" :semantic-xml="semanticXml" />
      </div>
      <PromptTextField
        v-else
        v-model="content"
        :variables="file.variables ?? []"
        label="提示词正文"
        min-height="240px"
        fill
        :semantic-xml="semanticXml"
      />

      <div v-if="conflict" class="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-accent p-3">
        <span class="inline-state" data-kind="error">[CONFLICT · SERVER VERSION CHANGED]</span>
        <div class="flex gap-2">
          <button class="btn btn-ghost" type="button" @click="emit('keepLocal')">保留本地内容</button>
          <button class="btn" type="button" @click="emit('loadServer')">加载服务器版本</button>
        </div>
      </div>

      <footer class="mt-3 flex flex-wrap items-center justify-between gap-2 font-mono text-[10px] text-mute">
        <span>{{ file.fileName }}</span>
        <span class="inline-state" :data-kind="messageKind || undefined">{{ message || (dirty ? "[UNSAVED]" : "[SYNCED]") }}</span>
        <span>{{ lines }} LINES · {{ characters }} CHARS · ⌘/CTRL S</span>
      </footer>
    </div>
  </section>
</template>
