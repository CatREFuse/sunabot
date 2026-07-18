<script setup lang="ts">
import { computed } from "vue";
import type { ScheduledTaskSchedule } from "../../types/scheduledTasks";
import {
  defaultCronSchedule,
  defaultOnceSchedule,
  fromDateTimeLocal,
  toDateTimeLocal
} from "./cronSchedule";
import CronScheduleEditor from "./CronScheduleEditor.vue";

const schedule = defineModel<ScheduledTaskSchedule>({ required: true });
const onceValue = computed(() => schedule.value.kind === "once" ? toDateTimeLocal(schedule.value.runAt) : "");

function selectKind(kind: ScheduledTaskSchedule["kind"]) {
  if (kind === schedule.value.kind) return;
  schedule.value = kind === "cron" ? defaultCronSchedule() : defaultOnceSchedule();
}

function updateOnce(event: Event) {
  const runAt = fromDateTimeLocal((event.target as HTMLInputElement).value);
  schedule.value = { kind: "once", runAt };
}
</script>

<template>
  <section class="grid gap-5" aria-labelledby="scheduled-task-trigger-title">
    <div>
      <h3 id="scheduled-task-trigger-title" class="text-base font-medium text-display">触发时间</h3>
    </div>
    <div class="segmented w-fit" aria-label="触发方式">
      <button class="segmented-button" type="button" :aria-pressed="schedule.kind === 'cron'" @click="selectKind('cron')">重复执行</button>
      <button class="segmented-button" type="button" :aria-pressed="schedule.kind === 'once'" @click="selectKind('once')">单次执行</button>
    </div>
    <CronScheduleEditor v-if="schedule.kind === 'cron'" v-model="schedule" />
    <label v-else class="field">
      <span class="field-label">执行时间</span>
      <input :value="onceValue" class="control" type="datetime-local" step="60" @input="updateOnce">
      <small class="text-xs text-mute">按当前设备时区设置</small>
    </label>
  </section>
</template>
