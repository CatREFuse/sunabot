<script setup lang="ts">
import { computed } from "vue";
import type { AgentFileSummary } from "../../types";

const props = defineProps<{ files: readonly AgentFileSummary[]; selectedId: string; query: string; error?: string }>();
const emit = defineEmits<{ select: [id: string]; "update:query": [value: string] }>();
const categoryNames: Record<string, string> = {
  persona: "人格",
  memory: "记忆",
  orchestrator: "编排器",
  conversation: "会话",
  image: "图像"
};
const grouped = computed(() => {
  const term = props.query.trim().toLocaleLowerCase();
  const visible = term
    ? props.files.filter((item) => `${item.title} ${item.fileName} ${item.id}`.toLocaleLowerCase().includes(term))
    : props.files;
  const groups = new Map<string, AgentFileSummary[]>();
  for (const item of visible) {
    const group = groups.get(item.category) ?? [];
    group.push(item);
    groups.set(item.category, group);
  }
  return [...groups.entries()].map(([category, files]) => ({ category, label: categoryNames[category] ?? category, files }));
});
</script>

<template>
  <aside class="flex h-full min-h-0 min-w-0 flex-col border-r border-line bg-panel">
    <div class="border-b border-line p-4">
      <p class="page-kicker">PROMPTS</p>
      <h1 class="mt-2 font-sans text-[32px] font-medium leading-none tracking-[-0.03em] text-display">提示词</h1>
      <label class="field mt-5">
        <span class="field-label">搜索文件</span>
        <input :value="query" class="control" type="search" autocomplete="off" placeholder="名称或文件名" @input="emit('update:query', ($event.target as HTMLInputElement).value)">
      </label>
    </div>
    <div class="min-h-0 flex-1 overflow-y-auto p-3">
      <p v-if="error" class="mb-4 px-2 font-mono text-[10px] text-accent">[ERROR: {{ error }}]</p>
      <section v-for="group in grouped" :key="group.category" class="mb-6 last:mb-0">
        <h2 class="px-2 pb-2 font-mono text-[10px] uppercase tracking-[0.08em] text-disabled">{{ group.label }}</h2>
        <button
          v-for="item in group.files"
          :key="item.id"
          class="flex min-h-14 w-full min-w-0 items-center gap-3 border-t border-line px-2 text-left first:border-t-0"
          :class="selectedId === item.id ? 'bg-raised text-display' : 'text-mute hover:text-display'"
          type="button"
          @click="emit('select', item.id)"
        >
          <span class="min-w-0 flex-1">
            <strong class="block truncate text-sm font-normal">{{ item.title }}</strong>
            <small class="block truncate font-mono text-[10px] text-disabled">{{ item.fileName }}</small>
          </span>
          <span v-if="item.empty" class="font-mono text-[10px] text-warning">EMPTY</span>
        </button>
      </section>
      <div v-if="!grouped.length" class="empty-state min-h-40 py-12"><div><strong>没有匹配文件</strong></div></div>
    </div>
  </aside>
</template>
