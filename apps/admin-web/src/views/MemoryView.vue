<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, shallowRef, watch } from "vue";
import { useMemory } from "../composables/useMemory";
import type { MemoryEntry, MemorySourceId, MemoryWritePayload } from "../types";
import PageHeader from "../components/ui/PageHeader.vue";
import MemoryEditorDialog from "../components/memory/MemoryEditorDialog.vue";
import MemoryEntryRow from "../components/memory/MemoryEntryRow.vue";
import MemorySourceTabs from "../components/memory/MemorySourceTabs.vue";

const data = useMemory();
const source = shallowRef<MemorySourceId>("working");
const query = shallowRef("");
const searchMode = shallowRef<"filter" | "recall">("filter");
const editorOpen = shallowRef(false);
const editing = shallowRef<MemoryEntry | null>(null);
const editorError = shallowRef("");
const pendingDelete = shallowRef("");
const status = shallowRef("");
const statusKind = shallowRef<"success" | "error" | "">("");
const visibleEntries = computed(() => {
  const base = searchMode.value === "recall" && data.recallActive.value ? data.matches.value : data.entries.value;
  const term = searchMode.value === "filter" ? query.value.trim().toLocaleLowerCase() : "";
  return base.filter((entry) => {
    if (entry.source !== source.value) return false;
    const groupCards = entry.groupCards?.flatMap((card) => [card.card, card.groupId]).join(" ") ?? "";
    const searchable = [
      entry.text,
      entry.addressName,
      entry.userId,
      entry.userIds?.join(" "),
      entry.userName,
      entry.userNickname,
      groupCards,
      entry.occurredAt,
      entry.occurredEndAt,
      entry.time,
      entry.legacyTime
    ].filter(Boolean).join(" ").toLocaleLowerCase();
    return !term || searchable.includes(term);
  });
});

onMounted(() => void data.load(source.value));
onBeforeUnmount(data.dispose);
watch(source, (next) => {
  query.value = "";
  data.clearMatches();
  void data.load(next);
});
watch(searchMode, () => {
  query.value = "";
  data.clearMatches();
});

function openCreate() { editing.value = null; editorError.value = ""; editorOpen.value = true; }
function openEdit(entry: MemoryEntry) { editing.value = entry; editorError.value = ""; editorOpen.value = true; }

async function save(payload: MemoryWritePayload) {
  editorError.value = "";
  try {
    if (payload.id) await data.update({ ...payload, id: payload.id });
    else await data.create(payload);
    editorOpen.value = false;
    status.value = "已保存";
    statusKind.value = "success";
  } catch (error) {
    editorError.value = error instanceof Error ? error.message : "保存失败";
  }
}

async function remove(entry: MemoryEntry) {
  if (pendingDelete.value !== entry.id) { pendingDelete.value = entry.id; return; }
  try {
    await data.remove(entry);
    pendingDelete.value = "";
    status.value = "已删除";
    statusKind.value = "success";
  } catch (error) {
    status.value = `删除失败：${error instanceof Error ? error.message : "请稍后重试"}`;
    statusKind.value = "error";
  }
}

async function recall() {
  if (!query.value.trim()) return;
  try {
    await data.recall(query.value.trim(), source.value, 20);
    status.value = `找到 ${data.matches.value.length} 条记忆`;
    statusKind.value = "success";
  } catch (error) {
    status.value = `召回失败：${error instanceof Error ? error.message : "请稍后重试"}`;
    statusKind.value = "error";
  }
}

function submitSearch() {
  if (searchMode.value === "recall") void recall();
}
</script>

<template>
  <div class="page-shell">
    <div class="page-frame">
      <PageHeader title="记忆">
        <template #titleAfter>
          <MemorySourceTabs v-model="source" :sources="data.sources.value" />
        </template>
        <template #actions>
          <span v-if="status" class="inline-state" :data-kind="statusKind || undefined">{{ status }}</span>
          <button class="icon-btn" type="button" aria-label="刷新记忆" @click="data.load(source)"><i class="bx bx-refresh text-xl" aria-hidden="true"></i></button>
          <button class="btn btn-primary" type="button" @click="openCreate"><i class="bx bx-plus" aria-hidden="true"></i>新增</button>
        </template>
      </PageHeader>

      <section class="mt-8 flex min-h-12 min-w-0 flex-col gap-2 border-y border-visible py-2 sm:flex-row sm:items-center">
        <div class="segmented shrink-0" aria-label="搜索方式">
          <button class="segmented-button" type="button" :aria-pressed="searchMode === 'filter'" @click="searchMode = 'filter'"><i class="bx bx-filter-alt mr-1" aria-hidden="true"></i>筛选</button>
          <button class="segmented-button" type="button" :aria-pressed="searchMode === 'recall'" @click="searchMode = 'recall'"><i class="bx bx-brain mr-1" aria-hidden="true"></i>语义召回</button>
        </div>
        <label class="flex min-h-11 min-w-0 flex-1 items-center gap-2 px-2">
          <i class="bx bx-search text-lg text-mute" aria-hidden="true"></i>
          <input v-model="query" class="min-w-0 flex-1 bg-transparent font-mono text-xs outline-none placeholder:text-disabled" type="search" :placeholder="searchMode === 'filter' ? '筛选当前记忆' : '输入要回想的内容'" aria-label="搜索记忆" @keyup.enter="submitSearch">
        </label>
        <button v-if="searchMode === 'recall'" class="btn btn-primary shrink-0" type="button" :disabled="!query.trim() || data.loading.value" @click="recall"><i class="bx bx-search" aria-hidden="true"></i>召回</button>
      </section>

      <section class="mt-8 border-t border-visible">
        <p v-if="data.error.value" class="border-b border-line py-4 text-xs text-accent">{{ data.error.value }}</p>
        <MemoryEntryRow
          v-for="entry in visibleEntries"
          :key="`${entry.source}-${entry.id}`"
          :entry="entry"
          :pending-delete="pendingDelete === entry.id"
          @edit="openEdit"
          @remove="remove"
        />
        <div v-if="!visibleEntries.length && !data.error.value" class="empty-state">
          <div v-if="data.loading.value"><strong>正在读取记忆</strong></div>
          <div v-else-if="data.recallActive.value"><strong>没有匹配的记忆</strong><p>调整召回内容后重试</p></div>
          <div v-else><strong>没有记忆</strong><p>调整筛选或新增记忆</p></div>
        </div>
      </section>
    </div>

    <MemoryEditorDialog :open="editorOpen" :entry="editing" :sources="data.sources.value" :busy="data.mutating.value" :error="editorError" @close="editorOpen = false" @save="save" />
  </div>
</template>
