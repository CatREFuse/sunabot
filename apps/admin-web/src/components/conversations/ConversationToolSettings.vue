<script setup lang="ts">
import { computed, onBeforeUnmount, shallowRef, watch } from "vue";
import { useConversationTools } from "../../composables/useConversationTools";
import type { SunaTool, ToolName } from "../../types";
import { toolIcon } from "../../utils/toolCatalog";
import DialogOverlay from "../ui/DialogOverlay.vue";
import ToggleSwitch from "../ui/ToggleSwitch.vue";

const props = defineProps<{ conversationId: string }>();
const open = shallowRef(false);
const ready = shallowRef(false);
const draftDisabledTools = shallowRef<ToolName[]>([]);
const policy = useConversationTools(() => props.conversationId);
const enabledCount = computed(() => policy.tools.value.filter((tool) => (
  agentEnabled(tool) && !draftDisabledTools.value.includes(tool.name)
)).length);

watch(() => props.conversationId, () => {
  open.value = false;
  ready.value = false;
  policy.dispose();
});
onBeforeUnmount(policy.dispose);

async function openDialog() {
  open.value = true;
  ready.value = false;
  draftDisabledTools.value = [];
  if (await policy.load(true)) {
    draftDisabledTools.value = [...policy.disabledTools.value];
    ready.value = true;
  }
}

function agentEnabled(tool: SunaTool) {
  return tool.enabled !== false;
}

function selected(tool: SunaTool) {
  return agentEnabled(tool) && !draftDisabledTools.value.includes(tool.name);
}

function setSelected(tool: SunaTool, value: boolean) {
  if (!agentEnabled(tool)) return;
  const disabled = new Set(draftDisabledTools.value);
  if (value) disabled.delete(tool.name);
  else disabled.add(tool.name);
  draftDisabledTools.value = [...disabled];
}

async function save() {
  if (!await policy.save(draftDisabledTools.value)) return;
  open.value = false;
}
</script>

<template>
  <button class="btn btn-ghost" type="button" :disabled="!conversationId" @click="openDialog">
    <i class="bx bx-wrench mr-1 text-lg" aria-hidden="true"></i>工具
  </button>

  <DialogOverlay
    :open="open"
    :dismissible="!policy.saving.value"
    labelledby="conversation-tools-title"
    @close="open = false"
  >
    <section class="flex max-h-[min(760px,calc(100dvh-32px))] w-full max-w-2xl flex-col overflow-hidden border border-visible bg-panel shadow-2xl">
      <header class="flex items-center justify-between gap-4 border-b border-line px-4 py-4 md:px-6">
        <div class="min-w-0">
          <h2 id="conversation-tools-title" class="text-xl font-medium text-display">会话工具</h2>
          <p class="mt-1 text-xs text-mute">{{ enabledCount }} / {{ policy.tools.value.length }} 启用</p>
        </div>
        <button class="icon-btn" type="button" aria-label="关闭" :disabled="policy.saving.value" @click="open = false">
          <i class="bx bx-x text-xl" aria-hidden="true"></i>
        </button>
      </header>

      <div class="min-h-0 flex-1 overflow-y-auto px-4 md:px-6">
        <div v-if="policy.loading.value && !policy.tools.value.length" class="empty-state min-h-48 py-16">
          <div><strong>加载中</strong></div>
        </div>
        <div v-else-if="policy.tools.value.length" class="divide-y divide-line">
          <div
            v-for="tool in policy.tools.value"
            :key="tool.name"
            class="grid min-w-0 gap-3 py-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
          >
            <div class="flex min-w-0 items-start gap-3">
              <i class="bx w-8 shrink-0 text-2xl leading-8 text-[rgb(var(--color-interactive))]" :class="toolIcon(tool.name)" aria-hidden="true"></i>
              <div class="min-w-0">
                <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <strong class="text-sm font-medium text-display">{{ tool.title }}</strong>
                  <span class="font-mono text-[10px] text-disabled">{{ tool.name }}</span>
                </div>
                <p v-if="tool.summary" class="mt-1 text-xs leading-5 text-mute">{{ tool.summary }}</p>
                <p v-if="!agentEnabled(tool)" class="mt-1 text-xs text-accent">Agent 已停用</p>
                <p v-else-if="tool.available === false" class="mt-1 text-xs text-mute">当前能力不可用</p>
              </div>
            </div>
            <ToggleSwitch
              :model-value="selected(tool)"
              :label="`启用 ${tool.title}`"
              :disabled="!agentEnabled(tool) || policy.saving.value"
              @update:model-value="setSelected(tool, $event)"
            />
          </div>
        </div>
        <div v-else-if="!policy.loading.value" class="empty-state min-h-48 py-16">
          <div><strong>没有工具</strong></div>
        </div>
      </div>

      <footer class="flex flex-wrap items-center justify-between gap-3 border-t border-line px-4 py-4 md:px-6">
        <p v-if="policy.error.value" class="min-w-0 flex-1 text-sm text-accent" role="alert">{{ policy.error.value }}</p>
        <span v-else class="text-xs text-mute">Agent 总开关优先</span>
        <div class="ml-auto flex items-center gap-2">
          <button class="btn btn-ghost" type="button" :disabled="policy.saving.value" @click="open = false">取消</button>
          <button class="btn btn-primary" type="button" :disabled="!ready || policy.loading.value || policy.saving.value" @click="save">
            {{ policy.saving.value ? "保存中" : "保存" }}
          </button>
        </div>
      </footer>
    </section>
  </DialogOverlay>
</template>
