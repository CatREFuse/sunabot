<script setup lang="ts">
import type { KnowledgeSearchMatch } from "../../types/knowledge";
import { workbenchLabel, workbenchResourceKey } from "../../types/workbench";

defineProps<{
  matches: readonly KnowledgeSearchMatch[];
  active: boolean;
  searching: boolean;
}>();
const emit = defineEmits<{ search: []; clear: [] }>();
const query = defineModel<string>({ required: true });

function lineLabel(match: KnowledgeSearchMatch) {
  return match.startLine === match.endLine
    ? `第 ${match.startLine} 行`
    : `第 ${match.startLine}–${match.endLine} 行`;
}

function scoreLabel(score: number) {
  return score > 0 ? score.toFixed(4) : "0";
}
</script>

<template>
  <section aria-labelledby="knowledge-search-heading" class="mb-10 border-y border-visible py-4">
    <div class="flex min-w-0 flex-col gap-3 md:flex-row md:items-center">
      <h2 id="knowledge-search-heading" class="sr-only">知识库检索</h2>
      <label class="flex min-h-11 min-w-0 flex-1 items-center gap-2 px-2">
        <i class="bx bx-search text-lg text-mute" aria-hidden="true"></i>
        <input
          v-model="query"
          class="min-w-0 flex-1 bg-transparent font-mono text-sm outline-none placeholder:text-disabled"
          type="search"
          placeholder="检索知识库"
          aria-label="检索知识库"
          @keyup.enter="emit('search')"
        >
      </label>
      <div class="flex shrink-0 gap-2">
        <button v-if="active" class="btn btn-ghost" type="button" @click="emit('clear')">清除</button>
        <button class="btn btn-primary" type="button" :disabled="!query.trim() || searching" @click="emit('search')">
          <i class="bx bx-search" aria-hidden="true"></i>{{ searching ? "检索中" : "检索" }}
        </button>
      </div>
    </div>

    <div v-if="active" aria-live="polite" class="mt-4 border-t border-line">
      <article v-for="match in matches" :key="workbenchResourceKey(match.workbench ?? 'native', `${match.path}-${match.ordinal}`)" class="border-b border-line py-5">
        <div class="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1 font-mono text-[11px] text-mute">
          <span class="inline-state shrink-0 px-1.5 py-0.5 text-[9px]">{{ workbenchLabel(match.workbench ?? "native") }}</span>
          <strong class="break-all font-medium text-display">{{ match.path }}</strong>
          <span>{{ lineLabel(match) }}</span>
          <span>相关度 {{ scoreLabel(match.score) }}</span>
        </div>
        <p class="mt-3 whitespace-pre-wrap break-words text-sm leading-6 text-ink">{{ match.content }}</p>
      </article>
      <div v-if="!matches.length" class="empty-state min-h-40 py-12">
        <div><strong>没有匹配内容</strong></div>
      </div>
    </div>
  </section>
</template>
