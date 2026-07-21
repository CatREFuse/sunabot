<script setup lang="ts">
import { computed, onBeforeUnmount, shallowRef, watch } from "vue";
import { activeAgentIdState } from "../composables/agentScope";
import { useDreams } from "../composables/useDreams";
import { useMemory } from "../composables/useMemory";
import type { MemoryEntry, MemorySourceId, MemoryWritePayload } from "../types";
import DreamHistoryPanel from "../components/memory/DreamHistoryPanel.vue";
import PageHeader from "../components/ui/PageHeader.vue";
import MemoryEditorDialog from "../components/memory/MemoryEditorDialog.vue";
import MemoryEntryRow from "../components/memory/MemoryEntryRow.vue";
import MemoryPagination from "../components/memory/MemoryPagination.vue";
import MemorySortControl from "../components/memory/MemorySortControl.vue";
import { sortByMemoryTime, type MemorySortDirection, type MemorySortField } from "../utils/memorySort";

const PAGE_SIZE = 20;
type MemorySectionId = MemorySourceId | "dream";

const data = useMemory();
const agentId = computed(() => activeAgentIdState.value || "plana");
const dreams = useDreams(agentId.value);
const source = shallowRef<MemorySourceId>("working");
const activeSection = shallowRef<MemorySectionId>("working");
const query = shallowRef("");
const page = shallowRef(1);
const sortField = shallowRef<MemorySortField>("updatedAt");
const sortDirection = shallowRef<MemorySortDirection>("desc");
const searchMode = shallowRef<"filter" | "recall">("filter");
const editorOpen = shallowRef(false);
const editing = shallowRef<MemoryEntry | null>(null);
const editorError = shallowRef("");
const pendingDelete = shallowRef("");
const status = shallowRef("");
const statusKind = shallowRef<"success" | "error" | "">("");
const sections = computed<readonly { id: MemorySectionId; title: string }[]>(() => [
  ...data.sources.value.map((item) => ({ id: item.id, title: item.title })),
  { id: "dream", title: "梦境" }
]);
const filteredEntries = computed(() => {
  const base = searchMode.value === "recall" && data.recallActive.value ? data.matches.value : data.entries.value;
  const term = searchMode.value === "filter" ? query.value.trim().toLocaleLowerCase() : "";
  return base.filter((entry) => {
    if (entry.source !== source.value) return false;
    const groupCards = entry.groupCards?.flatMap((card) => [card.card, card.groupId]).join(" ") ?? "";
    const searchable = [
      entry.text,
      entry.addressNames?.join(" "),
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
const sortedEntries = computed(() => sortByMemoryTime(
  filteredEntries.value,
  sortField.value,
  sortDirection.value,
  (entry) => ({
    createdAt: entry.createdAt ?? entry.legacyCreatedAt,
    updatedAt: entry.updatedAt ?? entry.createdAt ?? entry.legacyCreatedAt,
    lastRecalledAt: entry.lastRecalledAt
  })
));
const pageCount = computed(() => Math.max(1, Math.ceil(sortedEntries.value.length / PAGE_SIZE)));
const visibleEntries = computed(() => {
  const offset = (page.value - 1) * PAGE_SIZE;
  return sortedEntries.value.slice(offset, offset + PAGE_SIZE);
});

onBeforeUnmount(data.dispose);
onBeforeUnmount(dreams.dispose);
watch(source, (next) => {
  query.value = "";
  data.clearMatches();
  void data.load(next, agentId.value);
});
watch(agentId, (nextAgentId) => {
  query.value = "";
  page.value = 1;
  data.clearMatches();
  editorOpen.value = false;
  editing.value = null;
  editorError.value = "";
  pendingDelete.value = "";
  status.value = "";
  statusKind.value = "";
  void data.load(source.value, nextAgentId);
  void dreams.load(nextAgentId);
}, { immediate: true });
watch(searchMode, () => {
  query.value = "";
  data.clearMatches();
});
watch([source, searchMode, query, sortField, sortDirection], () => { page.value = 1; });
watch(pageCount, (next) => { page.value = Math.min(page.value, next); });

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
function changePage(next: number) {
  page.value = Math.min(Math.max(next, 1), pageCount.value);
}
function selectSection(next: MemorySectionId) {
  activeSection.value = next;
  if (next === "dream") {
    editorOpen.value = false;
    editing.value = null;
    editorError.value = "";
    pendingDelete.value = "";
    return;
  }
  source.value = next;
}
</script>

<template>
  <div class="page-shell">
    <div class="page-frame">
      <PageHeader title="记忆">
        <template #titleAfter>
          <nav class="-mx-1 overflow-x-auto px-1" aria-label="记忆类别">
            <div class="segmented w-max min-w-full md:min-w-0">
              <button
                v-for="item in sections"
                :key="item.id"
                class="segmented-button shrink-0"
                type="button"
                :aria-pressed="activeSection === item.id"
                @click="selectSection(item.id)"
              >{{ item.title }}</button>
            </div>
          </nav>
        </template>
        <template #actions>
          <template v-if="activeSection !== 'dream'">
            <span v-if="status" class="inline-state" :data-kind="statusKind || undefined">{{ status }}</span>
            <button class="icon-btn" type="button" aria-label="刷新记忆" @click="data.load(source, agentId)"><i class="bx bx-refresh text-xl" aria-hidden="true"></i></button>
            <button class="btn btn-primary" type="button" @click="openCreate"><i class="bx bx-plus" aria-hidden="true"></i>新增</button>
          </template>
        </template>
      </PageHeader>

      <section
        class="mt-8 flex min-w-0 justify-end py-2"
        :class="activeSection === 'dream' ? '' : 'border-y border-visible'"
      >
        <MemorySortControl v-model:field="sortField" v-model:direction="sortDirection" />
      </section>

      <DreamHistoryPanel
        v-if="activeSection === 'dream'"
        :items="dreams.items.value"
        :loading="dreams.loading.value"
        :error="dreams.error.value"
        :time-zone="dreams.timeZone.value"
        :next-scheduled-for="dreams.nextScheduledFor.value || undefined"
        :sort-field="sortField"
        :sort-direction="sortDirection"
        :triggering="dreams.triggering.value"
        :trigger-status="dreams.triggerStatus.value"
        :trigger-status-kind="dreams.triggerStatusKind.value"
        @refresh="dreams.load(agentId)"
        @trigger="dreams.trigger(agentId)"
      />

      <section v-if="activeSection !== 'dream'" class="mt-6 flex min-h-12 min-w-0 flex-col gap-2 border-y border-visible py-2 sm:flex-row sm:items-center">
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

      <section v-if="activeSection !== 'dream'" class="mt-8 border-t border-visible">
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
        <MemoryPagination
          class="mt-6"
          :page="page"
          :page-count="pageCount"
          :page-size="PAGE_SIZE"
          :total="filteredEntries.length"
          :loading="data.loading.value"
          @change="changePage"
        />
      </section>
    </div>

    <MemoryEditorDialog v-if="activeSection !== 'dream'" :open="editorOpen" :entry="editing" :sources="data.sources.value" :busy="data.mutating.value" :error="editorError" @close="editorOpen = false" @save="save" />
  </div>
</template>
