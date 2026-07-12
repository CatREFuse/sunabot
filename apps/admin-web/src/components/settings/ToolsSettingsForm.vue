<script setup lang="ts">
import { nextTick, shallowRef } from "vue";
import type { ConfigEnvelope, ConfigSectionValueMap, ModelCatalogItem } from "../../types";
import ToolCatalogSettings from "./ToolCatalogSettings.vue";
import ToolRuntimeSettings from "./ToolRuntimeSettings.vue";

type ToolsTab = "catalog" | "runtime";

const draft = defineModel<ConfigSectionValueMap["tools"]>({ required: true });
const bash = defineModel<ConfigSectionValueMap["bash"]>("bash", { required: true });
defineProps<{
  models: readonly ModelCatalogItem[];
  fieldStates?: ConfigEnvelope["fieldStates"];
}>();
const activeTab = shallowRef<ToolsTab>("catalog");
const tabs: Array<{ id: ToolsTab; label: string; icon: string }> = [
  { id: "catalog", label: "工具目录", icon: "bx-grid-alt" },
  { id: "runtime", label: "运行参数", icon: "bx-slider-alt" }
];

function selectTab(tab: ToolsTab) {
  activeTab.value = tab;
}

function onTabKeydown(event: KeyboardEvent, index: number) {
  let nextIndex = index;
  if (event.key === "ArrowRight") nextIndex = (index + 1) % tabs.length;
  else if (event.key === "ArrowLeft") nextIndex = (index - 1 + tabs.length) % tabs.length;
  else if (event.key === "Home") nextIndex = 0;
  else if (event.key === "End") nextIndex = tabs.length - 1;
  else return;
  event.preventDefault();
  const next = tabs[nextIndex];
  if (!next) return;
  activeTab.value = next.id;
  const tablist = (event.currentTarget as HTMLElement | null)?.parentElement;
  void nextTick(() => tablist?.querySelectorAll<HTMLElement>("[role='tab']")[nextIndex]?.focus());
}
</script>

<template>
  <section class="grid min-w-0 gap-8">
    <header>
      <h2 class="section-title">Agent 工具</h2>
    </header>

    <div class="flex min-h-12 min-w-0 overflow-x-auto border-b border-line" role="tablist" aria-label="工具设置">
      <button
        v-for="(tab, index) in tabs"
        :id="`tools-tab-${tab.id}`"
        :key="tab.id"
        class="relative min-h-12 shrink-0 px-4 font-mono text-xs text-mute transition-colors duration-200 hover:text-display"
        :class="activeTab === tab.id ? 'bg-raised text-display after:absolute after:inset-x-4 after:bottom-0 after:h-0.5 after:bg-display' : ''"
        type="button"
        role="tab"
        :aria-selected="activeTab === tab.id"
        :aria-controls="`tools-panel-${tab.id}`"
        :tabindex="activeTab === tab.id ? 0 : -1"
        @click="selectTab(tab.id)"
        @keydown="onTabKeydown($event, index)"
      >
        <i class="bx mr-2 text-base" :class="tab.icon" aria-hidden="true"></i>{{ tab.label }}
      </button>
    </div>

    <section
      id="tools-panel-catalog"
      role="tabpanel"
      aria-labelledby="tools-tab-catalog"
      :hidden="activeTab !== 'catalog'"
    >
      <ToolCatalogSettings v-model="draft" v-model:bash="bash" />
    </section>
    <section
      id="tools-panel-runtime"
      role="tabpanel"
      aria-labelledby="tools-tab-runtime"
      :hidden="activeTab !== 'runtime'"
    >
      <ToolRuntimeSettings v-model="draft" :models="models" :field-states="fieldStates" />
    </section>
  </section>
</template>
