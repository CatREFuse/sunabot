<script setup lang="ts">
import { computed, onMounted, shallowRef } from "vue";
import { useToolCatalog } from "../../composables/useToolCatalog";
import type { ConfigSectionValueMap, SunaTool, ToolOverride } from "../../types";
import ToolCatalogRow from "./ToolCatalogRow.vue";
import ToolDetailDialog from "./ToolDetailDialog.vue";

const draft = defineModel<ConfigSectionValueMap["tools"]>({ required: true });
const bash = defineModel<ConfigSectionValueMap["bash"]>("bash", { required: true });
const pokeOnNoReply = defineModel<boolean>("pokeOnNoReply", { default: false });
const emit = defineEmits<{ commit: [] }>();
const catalog = useToolCatalog();
const query = shallowRef("");
const selectedName = shallowRef("");
const normalizedQuery = computed(() => query.value.trim().toLocaleLowerCase());
const filteredTools = computed(() => {
  const search = normalizedQuery.value;
  if (!search) return catalog.tools.value;
  return catalog.tools.value.filter((tool) => [
    tool.title,
    tool.name,
    tool.summary,
    tool.accessLabel,
    tool.accessDescription,
    tool.availabilityReason,
    descriptionFor(tool)
  ].some((value) => String(value ?? "").toLocaleLowerCase().includes(search)));
});
const enabledCount = computed(() => catalog.tools.value.filter(toolEnabled).length);
const selectedTool = computed(() => catalog.tools.value.find((tool) => tool.name === selectedName.value) ?? null);

onMounted(() => void catalog.load());

function toolEnabled(tool: SunaTool) {
  if (tool.name === "workspace_bash") return bash.value.enabled;
  if (tool.name === "codex") return draft.value.codex.enabled;
  return draft.value.overrides[tool.name]?.enabled ?? tool.enabled;
}

function descriptionFor(tool: SunaTool) {
  const override = draft.value.overrides[tool.name]?.description;
  if (typeof override === "string") return override;
  if (tool.descriptionSource === "override") {
    return tool.promptDescription ?? tool.defaultDescription ?? tool.description;
  }
  return tool.description;
}

function hasDescriptionOverride(tool: SunaTool) {
  return typeof draft.value.overrides[tool.name]?.description === "string";
}

function setEnabled(tool: SunaTool, enabled: boolean) {
  if (tool.name === "workspace_bash" || tool.name === "codex") {
    if (tool.name === "workspace_bash") bash.value.enabled = enabled;
    else draft.value.codex.enabled = enabled;
    updateOverride(tool.name, (override) => { delete override.enabled; });
    emit("commit");
    return;
  }
  const inherited = tool.promptEnabled ?? tool.inheritedEnabled ?? true;
  updateOverride(tool.name, (override) => {
    if (enabled === inherited) delete override.enabled;
    else override.enabled = enabled;
  });
  emit("commit");
}

function setDescription(tool: SunaTool, description: string) {
  updateOverride(tool.name, (override) => { override.description = description; });
  emit("commit");
}

function resetDescription(tool: SunaTool) {
  updateOverride(tool.name, (override) => { delete override.description; });
  emit("commit");
}

function setPokeOnNoReply(enabled: boolean) {
  pokeOnNoReply.value = enabled;
  emit("commit");
}

function updateOverride(name: string, update: (override: ToolOverride) => void) {
  const override = { ...(draft.value.overrides[name] ?? {}) };
  update(override);
  if (override.enabled === undefined && override.description === undefined) delete draft.value.overrides[name];
  else draft.value.overrides[name] = override;
}
</script>

<template>
  <section class="grid min-w-0 gap-6" aria-label="工具目录">
    <header class="flex min-w-0 flex-wrap items-end justify-between gap-4">
      <div>
        <h3 class="section-title">工具目录</h3>
      </div>
      <div class="flex items-center gap-2">
        <span class="inline-state"><i class="bx bx-check-circle mr-1 text-success" aria-hidden="true"></i>{{ enabledCount }} / {{ catalog.tools.value.length }} 启用</span>
        <button class="icon-btn" type="button" :disabled="catalog.loading.value" aria-label="刷新工具目录" @click="catalog.load(true)">
          <i class="bx bx-refresh text-xl" :class="catalog.loading.value ? 'bx-spin' : ''" aria-hidden="true"></i>
        </button>
      </div>
    </header>

    <label class="field">
      <span class="field-label">搜索</span>
      <span class="relative block">
        <i class="bx bx-search pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-lg text-mute" aria-hidden="true"></i>
        <input v-model="query" class="control !pl-10" type="search" aria-label="搜索工具" placeholder="名称、ID 或说明">
      </span>
    </label>

    <div v-if="catalog.error.value" class="flex min-w-0 flex-wrap items-center justify-between gap-3 border-y border-accent/40 py-3">
      <p class="min-w-0 break-words text-sm text-accent"><i class="bx bx-error-circle mr-1" aria-hidden="true"></i>{{ catalog.error.value }}</p>
      <button class="btn btn-ghost" type="button" :disabled="catalog.loading.value" @click="catalog.load(true)">重试</button>
    </div>

    <div v-if="catalog.loading.value && !catalog.loaded.value" class="empty-state min-h-48 py-16">
      <div><strong>加载中</strong></div>
    </div>
    <div v-else-if="filteredTools.length" class="border-y border-line px-1 sm:px-2">
      <ToolCatalogRow
        v-for="tool in filteredTools"
        :key="tool.name"
        :tool="tool"
        :enabled="toolEnabled(tool)"
        :description-overridden="hasDescriptionOverride(tool)"
        @toggle="setEnabled(tool, $event)"
        @edit="selectedName = tool.name"
      />
    </div>
    <div v-else class="empty-state min-h-48 py-16">
      <div><strong>{{ query ? "没有匹配的工具" : "没有工具" }}</strong><p v-if="query">换个关键词试试</p></div>
    </div>

    <ToolDetailDialog
      :open="Boolean(selectedTool)"
      :tool="selectedTool"
      :enabled="selectedTool ? toolEnabled(selectedTool) : false"
      :description="selectedTool ? descriptionFor(selectedTool) : ''"
      :description-overridden="selectedTool ? hasDescriptionOverride(selectedTool) : false"
      :poke-on-no-reply="pokeOnNoReply"
      @close="selectedName = ''"
      @update:poke-on-no-reply="setPokeOnNoReply"
      @update-description="selectedTool && setDescription(selectedTool, $event)"
      @reset-description="selectedTool && resetDescription(selectedTool)"
    />
  </section>
</template>
