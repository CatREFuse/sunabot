<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, shallowRef, useTemplateRef, watch } from "vue";
import { activeAgentIdState } from "../composables/agentScope";
import { useDreams } from "../composables/useDreams";
import { useMemory } from "../composables/useMemory";
import { useMemoryOperationLogs } from "../composables/useMemoryOperationLogs";
import type { MemoryEntry, MemorySourceId, MemoryWritePayload } from "../types";
import DreamHistoryPanel from "../components/memory/DreamHistoryPanel.vue";
import MemoryEditorDialog from "../components/memory/MemoryEditorDialog.vue";
import MemoryEntryRow from "../components/memory/MemoryEntryRow.vue";
import MemoryInspector from "../components/memory/MemoryInspector.vue";
import MemoryOperationLogDrawer from "../components/memory/MemoryOperationLogDrawer.vue";
import MemoryPagination from "../components/memory/MemoryPagination.vue";
import MemorySortControl from "../components/memory/MemorySortControl.vue";
import DialogOverlay from "../components/ui/DialogOverlay.vue";
import { sortByMemoryTime, type MemorySortDirection, type MemorySortField } from "../utils/memorySort";

const PAGE_SIZE = 20;
type MemorySectionId = MemorySourceId | "dream";
type EditableMemorySourceId = Exclude<MemorySourceId, "working">;

const data = useMemory();
const operationLogs = useMemoryOperationLogs();
const agentId = computed(() => activeAgentIdState.value || "plana");
const dreams = useDreams(agentId.value);
const source = shallowRef<MemorySourceId>("working");
const activeSection = shallowRef<MemorySectionId>("working");
const query = shallowRef("");
const committedRecallQuery = shallowRef("");
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
const operationLogsOpen = shallowRef(false);
const selectedEntry = shallowRef<MemoryEntry | null>(null);
const mobileInspectorOpen = shallowRef(false);
const searchInput = useTemplateRef<HTMLInputElement>("searchInput");
let desktopInspectorMediaQuery: MediaQueryList | undefined;

const sections = computed<readonly { id: MemorySectionId; title: string }[]>(() => [
  ...data.sources.value.map((item) => ({ id: item.id, title: item.title })),
  { id: "dream", title: "梦境" }
]);
const activeTitle = computed(() => sections.value.find((item) => item.id === activeSection.value)?.title ?? "记忆");
const workingDocumentText = computed(() => (data.document.value?.content ?? "")
  .replace(/^<!-- sunabot-workmemory:[^\n]* -->\r?\n?/gmu, "")
  .trim());
const workingCount = computed(() =>
  (data.document.value?.content ?? "").match(/^<!-- sunabot-workmemory:item /gmu)?.length ?? 0);
const shortWorkingRevision = computed(() => data.document.value?.revision?.slice(0, 12) ?? "");
const sourceEntries = computed(() => data.entries.value.filter((entry) => entry.source === source.value));
const currentTotal = computed(() => {
  if (activeSection.value === "working") return workingCount.value;
  if (activeSection.value === "dream") return dreams.items.value.length;
  return sourceEntries.value.length;
});
const metricLabel = computed(() => ({
  working: "条工作记忆",
  long_term: "条长期记忆",
  user_profile: "位用户",
  dream: "次梦境"
} satisfies Record<MemorySectionId, string>)[activeSection.value]);
const editableSource = computed<EditableMemorySourceId>(() => source.value === "user_profile" ? "user_profile" : "long_term");
const listSection = computed(() => activeSection.value === "long_term" || activeSection.value === "user_profile");
const filteredEntries = computed(() => {
  const base = searchMode.value === "recall" && data.recallActive.value ? data.matches.value : sourceEntries.value;
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
const recallStale = computed(() => data.recallActive.value && query.value.trim() !== committedRecallQuery.value);

onBeforeUnmount(data.dispose);
onBeforeUnmount(dreams.dispose);
onBeforeUnmount(operationLogs.dispose);
onMounted(() => {
  window.addEventListener("keydown", focusSearchShortcut);
  desktopInspectorMediaQuery = window.matchMedia?.("(min-width: 1280px)");
  desktopInspectorMediaQuery?.addEventListener("change", closeMobileInspectorOnDesktop);
  if (desktopInspectorMediaQuery?.matches) mobileInspectorOpen.value = false;
});
onBeforeUnmount(() => {
  window.removeEventListener("keydown", focusSearchShortcut);
  desktopInspectorMediaQuery?.removeEventListener("change", closeMobileInspectorOnDesktop);
  desktopInspectorMediaQuery = undefined;
});

watch(source, (next) => {
  query.value = "";
  committedRecallQuery.value = "";
  data.clearMatches();
  selectedEntry.value = null;
  mobileInspectorOpen.value = false;
  void data.load(next, agentId.value);
});
watch(agentId, (nextAgentId) => {
  query.value = "";
  committedRecallQuery.value = "";
  page.value = 1;
  data.clearMatches();
  editorOpen.value = false;
  editing.value = null;
  editorError.value = "";
  pendingDelete.value = "";
  selectedEntry.value = null;
  mobileInspectorOpen.value = false;
  status.value = "";
  statusKind.value = "";
  operationLogsOpen.value = false;
  operationLogs.reset();
  void data.load(source.value, nextAgentId);
  void dreams.load(nextAgentId);
}, { immediate: true });
watch(searchMode, () => {
  query.value = "";
  committedRecallQuery.value = "";
  data.clearMatches();
});
watch([source, searchMode, query, sortField, sortDirection], () => { page.value = 1; });
watch(pageCount, (next) => { page.value = Math.min(page.value, next); });
watch(visibleEntries, (entries) => {
  if (selectedEntry.value && entries.some((entry) => entry.id === selectedEntry.value?.id)) return;
  selectedEntry.value = entries[0] ?? null;
  mobileInspectorOpen.value = false;
});

function focusSearchShortcut(event: KeyboardEvent) {
  if (!listSection.value || !(event.metaKey || event.ctrlKey) || event.key.toLocaleLowerCase() !== "k") return;
  const target = event.target instanceof HTMLElement ? event.target : null;
  if (
    editorOpen.value
    || mobileInspectorOpen.value
    || operationLogsOpen.value
    || target?.matches("input, textarea, select, [contenteditable='true'], [contenteditable='']")
    || target?.closest("[role='dialog']")
  ) return;
  event.preventDefault();
  searchInput.value?.focus();
}
function closeMobileInspectorOnDesktop(event: MediaQueryListEvent) {
  if (event.matches) mobileInspectorOpen.value = false;
}
function moveSectionFocus(event: KeyboardEvent, index: number) {
  const keyOffsets: Partial<Record<string, number>> = { ArrowLeft: -1, ArrowRight: 1 };
  let nextIndex = index;
  if (event.key === "Home") nextIndex = 0;
  else if (event.key === "End") nextIndex = sections.value.length - 1;
  else if (keyOffsets[event.key] != null) nextIndex = (index + keyOffsets[event.key]! + sections.value.length) % sections.value.length;
  else return;
  event.preventDefault();
  const next = sections.value[nextIndex];
  if (!next) return;
  selectSection(next.id);
  document.getElementById(`memory-tab-${next.id}`)?.focus();
}
function openCreate() {
  editing.value = null;
  editorError.value = "";
  editorOpen.value = true;
}
function openEdit(entry: MemoryEntry) {
  editing.value = entry;
  editorError.value = "";
  editorOpen.value = true;
  mobileInspectorOpen.value = false;
}
function selectEntry(entry: MemoryEntry) {
  selectedEntry.value = entry;
  pendingDelete.value = "";
  mobileInspectorOpen.value = Boolean(window.matchMedia?.("(max-width: 1279px)").matches);
}
function closeInspector() {
  selectedEntry.value = null;
  mobileInspectorOpen.value = false;
  pendingDelete.value = "";
}

async function save(payload: MemoryWritePayload) {
  editorError.value = "";
  try {
    const applied = payload.id
      ? await data.update({ ...payload, id: payload.id }, agentId.value)
      : await data.create(payload, agentId.value);
    if (!applied) return;
    editorOpen.value = false;
    selectedEntry.value = null;
    status.value = "已保存";
    statusKind.value = "success";
  } catch (error) {
    editorError.value = error instanceof Error ? error.message : "保存失败";
  }
}

async function remove(entry: MemoryEntry) {
  if (pendingDelete.value !== entry.id) {
    pendingDelete.value = entry.id;
    return;
  }
  try {
    const applied = await data.remove(entry, agentId.value);
    if (!applied) return;
    pendingDelete.value = "";
    selectedEntry.value = null;
    mobileInspectorOpen.value = false;
    status.value = "已删除";
    statusKind.value = "success";
  } catch (error) {
    status.value = `删除失败：${error instanceof Error ? error.message : "请稍后重试"}`;
    statusKind.value = "error";
  }
}

async function recall() {
  const nextQuery = query.value.trim();
  if (!nextQuery) return;
  try {
    const applied = await data.recall(nextQuery, source.value, 20, agentId.value);
    if (!applied) return;
    committedRecallQuery.value = nextQuery;
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
function clearRecall() {
  data.clearMatches();
  committedRecallQuery.value = "";
  query.value = "";
  status.value = "";
}
function changePage(next: number) {
  page.value = Math.min(Math.max(next, 1), pageCount.value);
}
function openOperationLogs() {
  operationLogsOpen.value = true;
  void operationLogs.load(agentId.value, 1);
}
function selectSection(next: MemorySectionId) {
  activeSection.value = next;
  editorOpen.value = false;
  editing.value = null;
  editorError.value = "";
  pendingDelete.value = "";
  selectedEntry.value = null;
  mobileInspectorOpen.value = false;
  status.value = "";
  statusKind.value = "";
  if (next !== "dream") source.value = next;
}
function sectionCount(sectionId: MemorySectionId) {
  if (sectionId === "dream") return dreams.items.value.length;
  return sectionId === activeSection.value ? currentTotal.value : null;
}
</script>

<template>
  <div class="page-shell">
    <div class="page-frame">
      <header class="border-b border-line pb-4 sm:pb-5">
        <div class="flex min-w-0 items-start justify-between gap-3 sm:items-center">
          <div class="flex min-w-0 items-baseline gap-4">
            <h1 class="text-[32px] font-medium leading-none tracking-[-0.04em] text-display">记忆</h1>
            <span class="hidden font-mono text-[11px] uppercase tracking-[0.08em] text-mute sm:inline">Agent {{ agentId }}</span>
          </div>
          <div class="flex shrink-0 items-center gap-0">
            <button class="btn btn-ghost" type="button" @click="openOperationLogs">
              <i class="bx bx-history" aria-hidden="true"></i>操作日志
            </button>
            <button v-if="activeSection !== 'dream'" class="icon-btn" type="button" aria-label="刷新记忆" @click="data.load(source, agentId)">
              <i class="bx bx-refresh" :class="data.loading.value ? 'bx-spin' : ''" aria-hidden="true"></i>
            </button>
            <button v-if="listSection" class="btn btn-primary" type="button" aria-label="新增记忆" @click="openCreate">
              <i class="bx bx-plus" aria-hidden="true"></i>新增
            </button>
          </div>
        </div>

        <nav class="-mx-2 mt-4 overflow-x-auto px-2 sm:mt-5" aria-label="记忆类别" role="tablist">
          <div class="flex w-max min-w-full gap-7">
            <button
              v-for="(item, index) in sections"
              :id="`memory-tab-${item.id}`"
              :key="item.id"
              class="relative min-h-11 shrink-0 bg-transparent pb-3 font-mono text-xs text-mute transition-colors duration-200 hover:text-display"
              :class="activeSection === item.id ? 'text-display' : ''"
              type="button"
              role="tab"
              :aria-label="item.title"
              :aria-selected="activeSection === item.id"
              :aria-controls="`memory-panel-${item.id}`"
              :tabindex="activeSection === item.id ? 0 : -1"
              @click="selectSection(item.id)"
              @keydown="moveSectionFocus($event, index)"
            >
              {{ item.title }}
              <span v-if="sectionCount(item.id) != null" class="ml-2 text-[10px] text-disabled">{{ sectionCount(item.id) }}</span>
              <span class="absolute inset-x-0 bottom-0 h-0.5 bg-display transition-opacity duration-200" :class="activeSection === item.id ? 'opacity-100' : 'opacity-0'" aria-hidden="true"></span>
            </button>
          </div>
        </nav>
      </header>

      <section class="flex min-w-0 items-baseline justify-between gap-6 py-5" aria-label="记忆数量">
        <div class="flex min-w-0 items-baseline gap-3">
          <strong class="font-display text-[48px] font-normal leading-none tracking-[-0.05em] text-display md:text-[56px]">{{ currentTotal }}</strong>
          <span class="font-mono text-[11px] uppercase tracking-[0.08em] text-mute">{{ metricLabel }}</span>
        </div>
        <p v-if="listSection && sortedEntries.length !== currentTotal" class="text-right font-mono text-[11px] text-mute">
          当前显示 {{ sortedEntries.length }} 条
        </p>
      </section>

      <p v-if="status" class="mb-5 inline-state" :data-kind="statusKind || undefined" role="status" aria-live="polite">{{ status }}</p>

      <section
        v-if="activeSection === 'working'"
        id="memory-panel-working"
        class="border-y border-visible"
        role="tabpanel"
        aria-labelledby="memory-tab-working"
        aria-label="工作记忆原文"
      >
        <header class="flex min-w-0 items-center justify-between gap-5 border-b border-line py-4">
          <div class="min-w-0">
            <h2 class="font-mono text-xs text-display">{{ data.document.value?.fileName || "WORKING_MEMORY.md" }}</h2>
            <p
              v-if="data.document.value?.revision"
              class="mt-1 truncate font-mono text-[10px] text-mute"
              :title="data.document.value.revision"
            >版本 {{ shortWorkingRevision }}</p>
          </div>
          <span class="field-label">只读</span>
        </header>
        <p v-if="data.error.value" class="py-5 text-xs text-accent" role="alert">{{ data.error.value }}</p>
        <pre v-else-if="workingDocumentText" class="working-memory-document">{{ workingDocumentText }}</pre>
        <div v-else class="empty-state">
          <div v-if="data.loading.value"><strong>[正在读取工作记忆]</strong></div>
          <div v-else><strong>没有工作记忆</strong></div>
        </div>
      </section>

      <section
        v-else-if="activeSection === 'dream'"
        id="memory-panel-dream"
        role="tabpanel"
        aria-labelledby="memory-tab-dream"
      >
        <DreamHistoryPanel
          :items="dreams.items.value"
          :loading="dreams.loading.value"
          :error="dreams.error.value"
          :time-zone="dreams.timeZone.value"
          :next-scheduled-for="dreams.nextScheduledFor.value || undefined"
          sort-field="updatedAt"
          sort-direction="desc"
          :triggering="dreams.triggering.value"
          :trigger-status="dreams.triggerStatus.value"
          :trigger-status-kind="dreams.triggerStatusKind.value"
          @refresh="dreams.load(agentId)"
          @trigger="dreams.trigger(agentId)"
        />
      </section>

      <section
        v-else
        :id="`memory-panel-${activeSection}`"
        role="tabpanel"
        :aria-labelledby="`memory-tab-${activeSection}`"
      >
        <div class="grid min-w-0 gap-6 xl:grid-cols-[minmax(0,1fr)_416px]">
          <div class="min-w-0">
            <div class="memory-command-bar border-y border-visible">
              <div class="memory-command-modes flex min-h-12 shrink-0 items-center p-1 md:border-r md:border-line">
                <button
                  class="min-h-10 px-3 font-mono text-[11px] text-mute transition-colors hover:text-display"
                  :class="searchMode === 'filter' ? 'bg-display text-page hover:text-page' : ''"
                  type="button"
                  :aria-pressed="searchMode === 'filter'"
                  @click="searchMode = 'filter'"
                >筛选</button>
                <button
                  class="min-h-10 px-3 font-mono text-[11px] text-mute transition-colors hover:text-display"
                  :class="searchMode === 'recall' ? 'bg-display text-page hover:text-page' : ''"
                  type="button"
                  :aria-pressed="searchMode === 'recall'"
                  @click="searchMode = 'recall'"
                >语义召回</button>
              </div>
              <div class="memory-command-search flex min-w-0 border-t border-line md:border-t-0">
                <label class="flex min-h-12 min-w-0 flex-1 items-center gap-3 px-4 focus-within:outline focus-within:outline-2 focus-within:outline-offset-[-2px] focus-within:outline-display">
                  <i class="bx bx-search text-lg text-mute" aria-hidden="true"></i>
                  <input
                    ref="searchInput"
                    v-model="query"
                    class="min-w-0 flex-1 bg-transparent font-mono text-xs outline-none placeholder:text-disabled"
                    type="search"
                    :placeholder="searchMode === 'filter' ? `搜索${activeTitle}` : '输入要回想的内容'"
                    aria-label="搜索记忆"
                    @keyup.enter="submitSearch"
                  >
                  <span class="hidden font-mono text-[10px] text-disabled lg:inline">⌘ K</span>
                </label>
                <button
                  v-if="searchMode === 'recall'"
                  class="btn btn-primary m-1 shrink-0 rounded"
                  type="button"
                  :disabled="!query.trim() || data.loading.value"
                  @click="recall"
                >召回</button>
              </div>
              <MemorySortControl class="memory-command-sort" v-model:field="sortField" v-model:direction="sortDirection" />
            </div>

            <div v-if="data.recallActive.value" class="flex min-w-0 items-center justify-between gap-4 border-b border-line py-3">
              <p class="min-w-0 truncate font-mono text-[11px] text-mute">
                语义召回 · “{{ committedRecallQuery }}” · {{ sortedEntries.length }} 条
                <span v-if="recallStale" class="ml-2 text-warning">查询已修改</span>
              </p>
              <button class="btn btn-ghost shrink-0" type="button" @click="clearRecall">返回全部</button>
            </div>

            <p v-if="data.error.value" class="border-b border-line py-4 text-xs text-accent" role="alert">{{ data.error.value }}</p>
            <TransitionGroup name="memory-list" tag="div" class="border-t border-line" aria-label="记忆列表">
              <MemoryEntryRow
                v-for="entry in visibleEntries"
                :key="`${entry.source}-${entry.id}`"
                :entry="entry"
                :selected="selectedEntry?.id === entry.id"
                @select="selectEntry"
              />
            </TransitionGroup>
            <div v-if="!visibleEntries.length && !data.error.value" class="empty-state">
              <div v-if="data.loading.value"><strong>[正在读取记忆]</strong></div>
              <div v-else-if="data.recallActive.value"><strong>没有匹配的记忆</strong><p>修改查询后再次召回</p></div>
              <div v-else-if="query"><strong>没有筛选结果</strong><p>清除搜索词后查看全部</p></div>
              <div v-else><strong>没有{{ activeTitle }}</strong></div>
            </div>
            <MemoryPagination
              :page="page"
              :page-count="pageCount"
              :page-size="PAGE_SIZE"
              :total="filteredEntries.length"
              :loading="data.loading.value"
              @change="changePage"
            />
          </div>

          <div class="hidden min-h-[520px] border-l border-line px-6 xl:block">
            <MemoryInspector
              v-if="selectedEntry"
              class="sticky top-0 h-[calc(100dvh-270px)] min-h-[560px] max-h-[780px]"
              :entry="selectedEntry"
              :pending-delete="pendingDelete === selectedEntry.id"
              @close="closeInspector"
              @edit="openEdit"
              @remove="remove"
            />
            <div v-else class="grid min-h-80 place-items-center text-center">
              <p class="font-mono text-[11px] text-mute">选择一条记忆查看详情</p>
            </div>
          </div>
        </div>
      </section>
    </div>

    <MemoryEditorDialog
      v-if="listSection"
      :open="editorOpen"
      :entry="editing"
      :source="editableSource"
      :busy="data.mutating.value"
      :error="editorError"
      @close="editorOpen = false"
      @save="save"
    />
    <DialogOverlay
      :open="Boolean(selectedEntry && mobileInspectorOpen)"
      placement="right"
      aria-label="移动记忆详情"
      class="xl:hidden"
      @close="mobileInspectorOpen = false"
    >
      <div v-if="selectedEntry" class="h-full w-full max-w-md border-l border-visible bg-panel p-5 sm:p-7">
        <MemoryInspector
          class="h-full"
          :entry="selectedEntry"
          :pending-delete="pendingDelete === selectedEntry.id"
          @close="mobileInspectorOpen = false"
          @edit="openEdit"
          @remove="remove"
        />
      </div>
    </DialogOverlay>
    <MemoryOperationLogDrawer
      :open="operationLogsOpen"
      :agent-id="agentId"
      :logs="operationLogs.logs.value"
      :page="operationLogs.page.value"
      :page-size="operationLogs.pageSize"
      :total="operationLogs.total.value"
      :page-count="operationLogs.pageCount.value"
      :loading="operationLogs.loading.value"
      :error="operationLogs.error.value"
      @close="operationLogsOpen = false"
      @refresh="operationLogs.load(agentId, operationLogs.page.value)"
      @page="operationLogs.load(agentId, $event)"
    />
  </div>
</template>

<style scoped>
.memory-command-bar {
  display: grid;
  grid-template-areas:
    "modes sort"
    "search search";
  grid-template-columns: minmax(0, 1fr) auto;
}

.memory-command-modes {
  grid-area: modes;
}

.memory-command-search {
  grid-area: search;
}

.memory-command-sort {
  grid-area: sort;
}

.working-memory-document {
  max-width: 900px;
  min-width: 0;
  padding-block: 24px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-family: "Space Mono", ui-monospace, monospace;
  font-size: 13px;
  line-height: 1.85;
  color: rgb(var(--color-ink));
}

.memory-list-enter-active,
.memory-list-leave-active {
  transition: opacity 180ms var(--motion-ease), transform 180ms var(--motion-ease);
}

.memory-list-enter-from,
.memory-list-leave-to {
  opacity: 0;
  transform: translateY(8px);
}

@media (min-width: 768px) {
  .memory-command-bar {
    grid-template-areas: "modes search sort";
    grid-template-columns: max-content minmax(0, 1fr) max-content;
  }
}

@media (max-width: 479px) {
  :deep(.btn) {
    padding-inline: 14px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .memory-list-enter-active,
  .memory-list-leave-active {
    transition: none;
  }
}
</style>
