<script setup lang="ts">
import type { ConversationRecord } from "../../types";
import type { ScheduledTaskTarget } from "../../types/scheduledTasks";
import ScheduledTaskTargetRow from "./ScheduledTaskTargetRow.vue";

const props = defineProps<{
  targets: readonly ScheduledTaskTarget[];
  conversations: readonly ConversationRecord[];
}>();
const emit = defineEmits<{ update: [targets: ScheduledTaskTarget[]] }>();

function addTarget() {
  if (props.targets.some((target) => !target.conversationId.trim())) return;
  emit("update", [...props.targets, { conversationId: "", mentionUserIds: [] }]);
}

function updateTarget(index: number, target: ScheduledTaskTarget) {
  emit("update", props.targets.map((item, itemIndex) => itemIndex === index ? target : { ...item }));
}

function removeTarget(index: number) {
  if (props.targets.length <= 1) return;
  emit("update", props.targets.filter((_, itemIndex) => itemIndex !== index).map((item) => ({ ...item })));
}
</script>

<template>
  <section aria-labelledby="scheduled-task-targets-title">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <h3 id="scheduled-task-targets-title" class="text-base font-medium text-display">回调目标</h3>
      <button class="btn btn-ghost" type="button" :disabled="targets.some((target) => !target.conversationId.trim())" @click="addTarget">
        <i class="bx bx-plus" aria-hidden="true"></i>添加会话
      </button>
    </div>
    <div class="mt-3 border-y border-line">
      <ScheduledTaskTargetRow
        v-for="(target, index) in targets"
        :key="`${target.conversationId || 'new'}-${index}`"
        :target="target"
        :conversations="conversations"
        :removable="targets.length > 1"
        @update="updateTarget(index, $event)"
        @remove="removeTarget(index)"
      />
    </div>
  </section>
</template>
