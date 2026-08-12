<script setup lang="ts">
import { computed, onBeforeUnmount, shallowRef, watch } from "vue";
import { useScheduledTasks } from "../../composables/useScheduledTasks";
import type { ScheduledTask, ScheduledTaskInput } from "../../types/scheduledTasks";
import ScheduledTaskDeleteDialog from "../scheduled-tasks/ScheduledTaskDeleteDialog.vue";
import ScheduledTaskEditorDialog from "../scheduled-tasks/ScheduledTaskEditorDialog.vue";
import ScheduledTaskList from "../scheduled-tasks/ScheduledTaskList.vue";
import ScheduledTaskPagination from "../scheduled-tasks/ScheduledTaskPagination.vue";

const props = defineProps<{ agentId: string }>();
const data = useScheduledTasks("director");
const editorOpen = shallowRef(false);
const editingTask = shallowRef<ScheduledTask | null>(null);
const pendingDelete = shallowRef<ScheduledTask | null>(null);
const editorError = computed(() => data.status.value.kind === "error" ? data.status.value.message : "");

watch(() => props.agentId, (agentId) => {
  editorOpen.value = false;
  editingTask.value = null;
  pendingDelete.value = null;
  void data.load(agentId);
}, { immediate: true });
onBeforeUnmount(data.dispose);

async function save(input: ScheduledTaskInput) {
  if (editingTask.value && await data.save(props.agentId, input, editingTask.value)) editorOpen.value = false;
}

async function confirmDelete() {
  if (pendingDelete.value && await data.remove(props.agentId, pendingDelete.value)) pendingDelete.value = null;
}
</script>

<template>
  <section id="director-panel-tasks" role="tabpanel" aria-labelledby="director-tab-tasks">
    <div class="mb-4 flex min-h-11 items-center justify-end gap-2">
      <span v-if="data.status.value.message" class="inline-state" :data-kind="data.status.value.kind">{{ data.status.value.message }}</span>
      <button class="icon-btn" type="button" :disabled="data.loading.value || data.mutationBusy.value" aria-label="刷新计划任务" @click="data.load(agentId)">
        <i class="bx bx-refresh text-xl" :class="data.loading.value ? 'bx-spin' : ''" aria-hidden="true"></i>
      </button>
    </div>
    <ScheduledTaskList
      id="director-task-panel"
      :tasks="data.tasks.value"
      category="director"
      :loading="data.loading.value"
      :mutation-busy="data.mutationBusy.value"
      :deleting-id="data.deletingId.value"
      :toggling-id="data.togglingId.value"
      :retaining-id="data.retainingId.value"
      :replaying-id="data.replayingId.value"
      @edit="editingTask = $event; editorOpen = true"
      @toggle="data.setEnabled(agentId, $event, !$event.enabled)"
      @toggle-permanent-retention="data.setPermanentRetention(agentId, $event, !$event.permanentRetention)"
      @replay="data.replayDelivery(agentId, $event)"
      @remove="pendingDelete = $event"
    />
    <ScheduledTaskPagination
      :page="data.pagination.value.page"
      :page-count="data.pagination.value.pageCount"
      :page-size="data.pagination.value.pageSize"
      :total="data.pagination.value.total"
      :loading="data.loading.value"
      @change="data.changePage(agentId, $event)"
    />
  </section>

  <ScheduledTaskEditorDialog
    :open="editorOpen"
    :task="editingTask"
    :conversations="data.conversations.value"
    :busy="data.saving.value"
    :error="editorError"
    @close="editorOpen = false"
    @save="save"
  />
  <ScheduledTaskDeleteDialog
    :task="pendingDelete"
    :busy="Boolean(pendingDelete && data.deletingId.value === pendingDelete.id)"
    @close="pendingDelete = null"
    @confirm="confirmDelete"
  />
</template>
