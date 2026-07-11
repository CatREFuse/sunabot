<script setup lang="ts">
import { Plus, RefreshCw, Search } from "lucide-vue-next";
import { computed, onBeforeUnmount, onMounted, shallowRef } from "vue";
import { useMemory } from "../composables/useMemory";
import type { MemoryEntry, MemorySourceId, MemoryWritePayload } from "../types";
import PageHeader from "../components/ui/PageHeader.vue";
import MemoryEditorDialog from "../components/memory/MemoryEditorDialog.vue";
import MemoryEntryRow from "../components/memory/MemoryEntryRow.vue";
import MemorySourceTabs from "../components/memory/MemorySourceTabs.vue";

const data = useMemory();
const source = shallowRef<MemorySourceId | "all">("all");
const query = shallowRef("");
const recallQuery = shallowRef("");
const editorOpen = shallowRef(false);
const editing = shallowRef<MemoryEntry | null>(null);
const editorError = shallowRef("");
const pendingDelete = shallowRef("");
const status = shallowRef("");
const visibleEntries = computed(() => {
  const base = data.recallActive.value ? data.matches.value : data.entries.value;
  const term = query.value.trim().toLocaleLowerCase();
  return base.filter((entry) => {
    if (source.value !== "all" && entry.source !== source.value) return false;
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

onMounted(() => void data.load());
onBeforeUnmount(data.dispose);

function openCreate() { editing.value = null; editorError.value = ""; editorOpen.value = true; }
function openEdit(entry: MemoryEntry) { editing.value = entry; editorError.value = ""; editorOpen.value = true; }

async function save(payload: MemoryWritePayload) {
  editorError.value = "";
  try {
    if (payload.id) await data.update({ ...payload, id: payload.id });
    else await data.create(payload);
    editorOpen.value = false;
    status.value = "[SAVED]";
  } catch (error) {
    editorError.value = error instanceof Error ? error.message : "保存失败";
  }
}

async function remove(entry: MemoryEntry) {
  if (pendingDelete.value !== entry.id) { pendingDelete.value = entry.id; return; }
  try {
    await data.remove(entry);
    pendingDelete.value = "";
    status.value = "[DELETED]";
  } catch (error) {
    status.value = `[ERROR: ${error instanceof Error ? error.message : "删除失败"}]`;
  }
}

async function recall() {
  if (!recallQuery.value.trim()) return;
  try {
    await data.recall(recallQuery.value.trim(), source.value, 20);
    status.value = `[${data.matches.value.length} MATCHES]`;
  } catch (error) {
    status.value = `[ERROR: ${error instanceof Error ? error.message : "召回失败"}]`;
  }
}
</script>

<template>
  <div class="page-shell">
    <div class="page-frame">
      <PageHeader kicker="MEMORY" title="记忆">
        <template #titleAfter>
          <MemorySourceTabs v-model="source" :sources="data.sources.value" @update:model-value="data.clearMatches" />
        </template>
        <template #actions>
          <span class="inline-state" :data-kind="status.startsWith('[ERROR') ? 'error' : status ? 'success' : undefined">{{ status }}</span>
          <button class="icon-btn" type="button" aria-label="刷新记忆" @click="data.load()"><RefreshCw :size="18" :stroke-width="1.5" /></button>
          <button class="btn btn-primary" type="button" @click="openCreate"><Plus :size="16" :stroke-width="1.5" />新增</button>
        </template>
      </PageHeader>

      <section class="mt-8 grid gap-4 lg:grid-cols-[minmax(0,1fr)_auto]">
        <label class="field"><span class="field-label">召回</span><span class="flex min-w-0 gap-2"><input v-model="recallQuery" class="control" type="search" placeholder="输入语义查询" @keyup.enter="recall"><button class="icon-btn" type="button" aria-label="召回" @click="recall"><Search :size="18" :stroke-width="1.5" /></button></span></label>
        <button v-if="data.recallActive.value" class="btn self-end" type="button" @click="data.clearMatches">清除召回</button>
      </section>

      <label class="mt-5 flex min-h-11 items-center gap-2 rounded-lg border border-visible bg-panel px-3">
        <Search :size="17" :stroke-width="1.5" class="text-mute" aria-hidden="true" />
        <input v-model="query" class="min-w-0 flex-1 bg-transparent font-mono text-xs outline-none placeholder:text-disabled" type="search" placeholder="筛选当前结果" aria-label="筛选记忆">
      </label>

      <section class="mt-8 border-t border-visible">
        <p v-if="data.error.value" class="border-b border-line py-4 font-mono text-xs text-accent">[ERROR: {{ data.error.value }}]</p>
        <MemoryEntryRow
          v-for="entry in visibleEntries"
          :key="`${entry.source}-${entry.id}`"
          :entry="entry"
          :pending-delete="pendingDelete === entry.id"
          @edit="openEdit"
          @remove="remove"
        />
        <div v-if="!visibleEntries.length && !data.error.value" class="empty-state">
          <div v-if="data.loading.value"><strong>[LOADING...]</strong></div>
          <div v-else-if="data.recallActive.value"><strong>没有匹配的记忆</strong><p>调整召回内容后重试</p></div>
          <div v-else><strong>没有记忆</strong><p>调整筛选或新增记忆</p></div>
        </div>
      </section>
    </div>

    <MemoryEditorDialog :open="editorOpen" :entry="editing" :sources="data.sources.value" :busy="data.mutating.value" :error="editorError" @close="editorOpen = false" @save="save" />
  </div>
</template>
