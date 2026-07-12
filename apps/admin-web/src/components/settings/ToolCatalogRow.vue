<script setup lang="ts">
import { computed } from "vue";
import type { SunaTool } from "../../types";
import { toolExecutionLabel, toolIcon } from "../../utils/toolCatalog";
import ToggleSwitch from "../ui/ToggleSwitch.vue";

const props = defineProps<{
  tool: SunaTool;
  enabled: boolean;
  descriptionOverridden: boolean;
}>();
const emit = defineEmits<{
  toggle: [enabled: boolean];
  edit: [];
}>();
const canToggle = computed(() => props.tool.configurable !== false);
const configuredState = computed(() => props.enabled
  ? { label: "配置已启用", icon: "bx-check-circle", kind: "success" }
  : { label: "配置已停用", icon: "bx-pause-circle", kind: "" });
const capabilityState = computed(() => props.tool.available === false
  ? { label: "能力不可用", icon: "bx-error-circle", kind: "error" }
  : { label: "能力可用", icon: "bx-check-shield", kind: "success" });
</script>

<template>
  <article class="grid min-w-0 gap-4 border-b border-line py-5 last:border-b-0 md:grid-cols-[minmax(0,1fr)_auto] md:items-center">
    <div class="flex min-w-0 items-start gap-3">
      <i class="bx w-10 shrink-0 text-[28px] leading-10 text-[rgb(var(--color-interactive))]" :class="toolIcon(tool.name)" aria-hidden="true"></i>
      <div class="min-w-0">
        <div class="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
          <strong class="text-sm font-medium text-display">{{ tool.title }}</strong>
          <span class="font-mono text-[10px] text-disabled">{{ tool.name }}</span>
        </div>
        <p v-if="tool.summary" class="mt-1 text-xs leading-5 text-mute">{{ tool.summary }}</p>
        <div class="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
          <span class="inline-state" :data-kind="configuredState.kind || undefined">
            <i class="bx mr-1" :class="configuredState.icon" aria-hidden="true"></i>{{ configuredState.label }}
          </span>
          <span class="inline-state" :data-kind="capabilityState.kind || undefined">
            <i class="bx mr-1" :class="capabilityState.icon" aria-hidden="true"></i>{{ capabilityState.label }}
          </span>
          <span class="font-mono text-[10px] text-mute">
            <i class="bx bx-transfer-alt mr-1" aria-hidden="true"></i>{{ toolExecutionLabel(tool.execution) }}
          </span>
          <span v-if="descriptionOverridden" class="font-mono text-[10px] text-[rgb(var(--color-interactive))]">
            <i class="bx bx-edit-alt mr-1" aria-hidden="true"></i>自定义说明
          </span>
          <span v-if="tool.configurable === false" class="font-mono text-[10px] text-mute">
            <i class="bx bx-lock-alt mr-1" aria-hidden="true"></i>固定配置
          </span>
        </div>
        <p v-if="tool.available === false && (tool.availabilityReason || tool.unavailableReason)" class="mt-2 text-xs leading-5 text-accent">
          {{ tool.availabilityReason || tool.unavailableReason }}
        </p>
      </div>
    </div>

    <div class="flex min-w-0 items-center justify-between gap-3 md:justify-end">
      <ToggleSwitch
        :model-value="enabled"
        :label="`启用 ${tool.title}`"
        :disabled="!canToggle"
        @update:model-value="emit('toggle', $event)"
      />
      <button class="icon-btn" type="button" :aria-label="`查看 ${tool.title} 详情`" @click="emit('edit')">
        <i class="bx bx-slider-alt text-lg" aria-hidden="true"></i>
      </button>
    </div>
  </article>
</template>
