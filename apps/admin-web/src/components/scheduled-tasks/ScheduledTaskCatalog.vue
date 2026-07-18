<script setup lang="ts">
import { computed, onBeforeUnmount, shallowRef, watch } from "vue";
import type { ScheduledTask, ScheduledTaskInput } from "../../types/scheduledTasks";
import { useScheduledTasks } from "../../composables/useScheduledTasks";
import PageHeader from "../ui/PageHeader.vue";
import ScheduledTaskDeleteDialog from "./ScheduledTaskDeleteDialog.vue";
import ScheduledTaskEditorDialog from "./ScheduledTaskEditorDialog.vue";
import ScheduledTaskList from "./ScheduledTaskList.vue";

const props = defineProps<{ agentId: string }>();
const data = useScheduledTasks();
const editorOpen = shallowRef(false);
const editingTask = shallowRef<ScheduledTask | null>(null);
const pendingDelete = shallowRef<ScheduledTask | null>(null);
const editorError = computed(() => data.status.value.kind === "error" ? data.status.value.message : "");

watch(
  () => props.agentId,
  (agentId) => {
    editorOpen.value = false;
    editingTask.value = null;
    pendingDelete.value = null;
    void data.load(agentId);
  },
  { immediate: true }
);
onBeforeUnmount(data.dispose);

function openCreate() {
  data.clearStatus();
  editingTask.value = null;
  editorOpen.value = true;
}

function openEdit(task: ScheduledTask) {
  data.clearStatus();
  editingTask.value = task;
  editorOpen.value = true;
}

async function save(input: ScheduledTaskInput) {
  if (await data.save(props.agentId, input, editingTask.value ?? undefined)) editorOpen.value = false;
}

async function toggle(task: ScheduledTask) {
  await data.setEnabled(props.agentId, task, !task.enabled);
}

async function confirmDelete() {
  const task = pendingDelete.value;
  if (!task) return;
  if (await data.remove(props.agentId, task)) pendingDelete.value = null;
}
</script>

<template>
  <div class="page-shell">
    <div class="page-frame">
      <PageHeader title="定时任务">
        <template #actions>
          <span v-if="data.status.value.message" class="inline-state" :data-kind="data.status.value.kind">{{ data.status.value.message }}</span>
          <button class="icon-btn" type="button" :disabled="data.loading.value || data.mutationBusy.value" aria-label="刷新定时任务" @click="data.load(agentId)">
            <i class="bx bx-refresh text-xl" :class="data.loading.value ? 'bx-spin' : ''" aria-hidden="true"></i>
          </button>
          <button class="btn btn-primary" type="button" :disabled="data.mutationBusy.value" @click="openCreate"><i class="bx bx-plus" aria-hidden="true"></i>新建任务</button>
        </template>
      </PageHeader>

      <ScheduledTaskList
        :tasks="data.tasks.value"
        :loading="data.loading.value"
        :mutation-busy="data.mutationBusy.value"
        :deleting-id="data.deletingId.value"
        :toggling-id="data.togglingId.value"
        @create="openCreate"
        @edit="openEdit"
        @toggle="toggle"
        @remove="pendingDelete = $event"
      />
    </div>

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
  </div>
</template>
