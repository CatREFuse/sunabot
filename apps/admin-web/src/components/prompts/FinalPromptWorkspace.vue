<script setup lang="ts">
import { nextTick, shallowRef, watch } from "vue";

export interface FinalPromptWorkspaceSection {
  id: string;
  kicker: string;
  label: string;
  kind: "message" | "response" | "tools";
  index?: number;
}

const activeId = defineModel<string>({ required: true });
const props = defineProps<{ sections: readonly FinalPromptWorkspaceSection[] }>();
const emit = defineEmits<{ reorder: [fromIndex: number, toIndex: number] }>();
const draggedId = shallowRef("");
const dragOverId = shallowRef("");

watch(
  () => props.sections.map((section) => section.id),
  (ids) => {
    if (!ids.includes(activeId.value)) activeId.value = ids[0] ?? "";
  },
  { immediate: true }
);

function activate(id: string) {
  activeId.value = id;
}

function clearDrag() {
  draggedId.value = "";
  dragOverId.value = "";
}

function onDragStart(event: DragEvent, section: FinalPromptWorkspaceSection) {
  const target = event.target;
  if (
    section.kind !== "message"
    || typeof section.index !== "number"
    || !(target instanceof HTMLElement)
    || !target.closest("[data-message-drag-handle]")
  ) return;
  draggedId.value = section.id;
  dragOverId.value = "";
  if (!event.dataTransfer) return;
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData("text/plain", section.id);
}

function onDragOver(event: DragEvent, section: FinalPromptWorkspaceSection) {
  if (!draggedId.value || section.kind !== "message") return;
  event.preventDefault();
  dragOverId.value = section.id;
  if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
}

function onDrop(event: DragEvent, section: FinalPromptWorkspaceSection) {
  if (!draggedId.value || section.kind !== "message" || typeof section.index !== "number") return;
  event.preventDefault();
  const source = props.sections.find((item) => item.id === draggedId.value);
  if (
    source?.kind === "message"
    && typeof source.index === "number"
    && source.index !== section.index
  ) {
    emit("reorder", source.index, section.index);
  }
  clearDrag();
}

function onTabKeydown(event: KeyboardEvent, index: number) {
  let nextIndex = index;
  if (event.key === "ArrowRight") nextIndex = (index + 1) % props.sections.length;
  else if (event.key === "ArrowLeft") nextIndex = (index - 1 + props.sections.length) % props.sections.length;
  else if (event.key === "Home") nextIndex = 0;
  else if (event.key === "End") nextIndex = props.sections.length - 1;
  else return;

  event.preventDefault();
  const next = props.sections[nextIndex];
  if (!next) return;
  const tabList = (event.currentTarget as HTMLElement | null)?.parentElement;
  activeId.value = next.id;
  void nextTick(() => {
    const tabs = tabList?.querySelectorAll<HTMLElement>("[data-prompt-tab]");
    tabs?.[nextIndex]?.focus();
  });
}
</script>

<template>
  <div class="prompt-workspace">
    <header class="prompt-workspace__toolbar">
      <span class="prompt-workspace__summary">{{ sections.length }} 个编辑槽位</span>
      <div class="prompt-workspace__tabs" role="tablist" aria-label="最终提示词槽位">
        <button
          v-for="(section, index) in sections"
          :id="`prompt-tab-${section.id}`"
          :key="section.id"
          class="prompt-workspace__tab"
          :class="{ 'prompt-workspace__tab--active': activeId === section.id }"
          type="button"
          role="tab"
          data-prompt-tab
          :aria-controls="`prompt-panel-${section.id}`"
          :aria-selected="activeId === section.id"
          :tabindex="activeId === section.id ? 0 : -1"
          @click="activate(section.id)"
          @keydown="onTabKeydown($event, index)"
        >
          {{ section.label }}
        </button>
      </div>
      <div class="prompt-workspace__actions">
        <slot name="actions" />
      </div>
    </header>

    <div class="prompt-workspace__grid">
      <section
        v-for="section in sections"
        :id="`prompt-panel-${section.id}`"
        :key="section.id"
        class="prompt-workspace__panel"
        :class="{
          'prompt-workspace__panel--active': activeId === section.id,
          'prompt-workspace__panel--dragging': draggedId === section.id,
          'prompt-workspace__panel--drag-over': dragOverId === section.id && draggedId !== section.id
        }"
        role="tabpanel"
        :aria-labelledby="`prompt-tab-${section.id}`"
        :tabindex="activeId === section.id ? 0 : -1"
        @dragstart="onDragStart($event, section)"
        @dragover="onDragOver($event, section)"
        @drop="onDrop($event, section)"
        @dragend="clearDrag"
      >
        <slot :section="section" />
      </section>
    </div>
  </div>
</template>

<style scoped>
.prompt-workspace {
  container-name: final-prompt;
  container-type: inline-size;
  display: flex;
  height: 100%;
  min-height: 0;
  min-width: 0;
  flex-direction: column;
}

.prompt-workspace__toolbar {
  display: flex;
  min-height: 48px;
  flex: none;
  align-items: center;
  gap: 12px;
  border-bottom: 1px solid rgb(var(--color-line));
}

.prompt-workspace__summary {
  display: none;
  font-family: "Space Mono", monospace;
  font-size: 10px;
  letter-spacing: 0.06em;
  color: rgb(var(--color-mute));
}

.prompt-workspace__tabs {
  display: flex;
  min-width: 0;
  flex: 1;
  align-self: stretch;
  overflow-x: auto;
  scrollbar-width: none;
}

.prompt-workspace__tabs::-webkit-scrollbar {
  display: none;
}

.prompt-workspace__tab {
  position: relative;
  min-height: 44px;
  flex: none;
  border: 0;
  background: transparent;
  padding: 0 14px;
  color: rgb(var(--color-mute));
  font-size: 12px;
  white-space: nowrap;
  transition: color 160ms ease, background-color 160ms ease;
}

.prompt-workspace__tab::after {
  position: absolute;
  right: 14px;
  bottom: 0;
  left: 14px;
  height: 2px;
  background: transparent;
  content: "";
}

.prompt-workspace__tab:hover,
.prompt-workspace__tab--active {
  color: rgb(var(--color-display));
}

.prompt-workspace__tab--active {
  background: transparent;
}

.prompt-workspace__tab--active::after {
  background: rgb(var(--color-display));
}

.prompt-workspace__actions {
  display: flex;
  flex: none;
  align-items: center;
  gap: 4px;
}

.prompt-workspace__grid {
  min-height: 0;
  min-width: 0;
  flex: 1;
  overflow: hidden;
}

.prompt-workspace__panel {
  display: none;
  height: 100%;
  min-width: 0;
  overflow-y: auto;
  padding: 20px 4px 28px 0;
}

.prompt-workspace__panel--active {
  display: block;
}

@container final-prompt (min-width: 1080px) {
  .prompt-workspace__toolbar {
    justify-content: space-between;
  }

  .prompt-workspace__summary {
    display: block;
  }

  .prompt-workspace__tabs {
    display: none;
  }

  .prompt-workspace__grid {
    display: grid;
    grid-auto-columns: minmax(340px, 1fr);
    grid-auto-flow: column;
    gap: 0;
    overflow-x: auto;
    border-top: 1px solid rgb(var(--color-line));
    border-bottom: 1px solid rgb(var(--color-line));
    padding: 0;
    background: transparent;
    overscroll-behavior-x: contain;
    scroll-snap-type: x proximity;
  }

  .prompt-workspace__panel,
  .prompt-workspace__panel--active {
    display: block;
    scroll-snap-align: start;
    border: 0;
    border-left: 1px solid rgb(var(--color-line));
    background: transparent;
    padding: 24px 24px 32px;
    transition: background-color 160ms ease, border-color 160ms ease, opacity 160ms ease;
  }

  .prompt-workspace__panel--dragging {
    opacity: 0.42;
  }

  .prompt-workspace__panel--drag-over {
    box-shadow: inset 2px 0 rgb(var(--color-display));
  }
}
</style>
