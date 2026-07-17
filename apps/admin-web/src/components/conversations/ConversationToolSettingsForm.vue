<script setup lang="ts">
import { computed } from "vue";
import type { SunaTool, ToolName } from "../../types";
import { toolIcon } from "../../utils/toolCatalog";
import ToggleSwitch from "../ui/ToggleSwitch.vue";

const props = defineProps<{
  tools: readonly SunaTool[];
  disabledTools: readonly ToolName[];
  loading: boolean;
  busy: boolean;
}>();
const emit = defineEmits<{ toggle: [name: ToolName, enabled: boolean] }>();
const enabledCount = computed(() => props.tools.filter((tool) => selected(tool)).length);

function agentEnabled(tool: SunaTool) {
  return tool.enabled !== false;
}

function selected(tool: SunaTool) {
  return agentEnabled(tool) && !props.disabledTools.includes(tool.name);
}
</script>

<template>
  <section aria-labelledby="conversation-tools-title">
    <header class="flex flex-wrap items-end justify-between gap-3 border-b border-visible pb-4">
      <div>
        <h2 id="conversation-tools-title" class="section-title">工具权限</h2>
        <p class="mt-2 font-mono text-[10px] text-mute">{{ loading ? "正在读取" : `当前会话 · ${enabledCount} / ${tools.length} 启用` }}</p>
      </div>
      <RouterLink class="btn btn-ghost" to="/agent-settings/tools">Agent 总开关</RouterLink>
    </header>
    <div v-if="loading" class="empty-state min-h-48 py-16">
      <div><strong>加载中</strong></div>
    </div>
    <div v-else-if="tools.length" class="divide-y divide-line">
      <div
        v-for="tool in tools"
        :key="tool.name"
        class="grid min-w-0 gap-3 py-5 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
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
            <p v-else-if="tool.available === false" class="mt-1 text-xs text-mute">
              {{ tool.availabilityReason || tool.unavailableReason || "当前能力不可用" }}
            </p>
          </div>
        </div>
        <ToggleSwitch
          :model-value="selected(tool)"
          :label="`启用 ${tool.title}`"
          :disabled="!agentEnabled(tool) || busy"
          @update:model-value="emit('toggle', tool.name, $event)"
        />
      </div>
    </div>
    <div v-else class="empty-state min-h-48 py-16">
      <div><strong>没有工具</strong></div>
    </div>
  </section>
</template>
