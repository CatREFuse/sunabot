<script setup lang="ts">
import { reactive, shallowRef, watch } from "vue";
import type { ScheduledTaskCronSchedule } from "../../types/scheduledTasks";
import {
  buildCronExpression,
  parseCronPreset,
  type CronPresetDraft,
  type CronPresetKind
} from "./cronSchedule";

const schedule = defineModel<ScheduledTaskCronSchedule>({ required: true });
const mode = shallowRef<"friendly" | "raw">(
  parseCronPreset(schedule.value.expression) ? "friendly" : "raw"
);
const friendly = reactive<CronPresetDraft>(parseCronPreset(schedule.value.expression) ?? {
  kind: "daily",
  interval: 15,
  minute: 0,
  hour: 9,
  weekDay: 1,
  monthDay: 1
});
let lastWrittenExpression = "";

watch(
  () => schedule.value.expression,
  (expression) => {
    const parsed = parseCronPreset(expression);
    if (expression === lastWrittenExpression) {
      lastWrittenExpression = "";
      if (parsed) Object.assign(friendly, parsed);
      return;
    }
    if (parsed) {
      Object.assign(friendly, parsed);
      mode.value = "friendly";
    } else {
      mode.value = "raw";
    }
  }
);

function selectMode(next: "friendly" | "raw") {
  mode.value = next;
  if (next === "friendly") updateFriendly();
}

function selectPreset(event: Event) {
  friendly.kind = (event.target as HTMLSelectElement).value as CronPresetKind;
  updateFriendly();
}

function updateFriendly() {
  updateExpression(buildCronExpression(friendly));
}

function updateRaw(event: Event) {
  updateExpression((event.target as HTMLInputElement).value);
}

function updateExpression(expression: string) {
  lastWrittenExpression = expression;
  schedule.value = { ...schedule.value, expression };
}

function updateTimezone(event: Event) {
  schedule.value = {
    ...schedule.value,
    timezone: (event.target as HTMLInputElement).value
  };
}
</script>

<template>
  <div class="grid gap-5">
    <div class="segmented w-fit max-w-full" aria-label="Cron 设置方式">
      <button class="segmented-button" type="button" :aria-pressed="mode === 'friendly'" @click="selectMode('friendly')">快捷设置</button>
      <button class="segmented-button" type="button" :aria-pressed="mode === 'raw'" @click="selectMode('raw')">Cron 表达式</button>
    </div>

    <div v-if="mode === 'friendly'" class="grid gap-4 sm:grid-cols-2">
      <label class="field sm:col-span-2">
        <span class="field-label">执行周期</span>
        <select class="control" :value="friendly.kind" @change="selectPreset">
          <option value="interval">每隔几分钟</option>
          <option value="hourly">每小时</option>
          <option value="daily">每天</option>
          <option value="weekly">每周</option>
          <option value="monthly">每月</option>
        </select>
      </label>

      <label v-if="friendly.kind === 'interval'" class="field sm:col-span-2">
        <span class="field-label">间隔分钟</span>
        <input v-model.number="friendly.interval" class="control" type="number" min="1" max="59" step="1" @input="updateFriendly">
      </label>

      <label v-if="friendly.kind === 'weekly'" class="field">
        <span class="field-label">星期</span>
        <select v-model.number="friendly.weekDay" class="control" @change="updateFriendly">
          <option :value="1">星期一</option>
          <option :value="2">星期二</option>
          <option :value="3">星期三</option>
          <option :value="4">星期四</option>
          <option :value="5">星期五</option>
          <option :value="6">星期六</option>
          <option :value="0">星期日</option>
        </select>
      </label>

      <label v-if="friendly.kind === 'monthly'" class="field">
        <span class="field-label">日期</span>
        <input v-model.number="friendly.monthDay" class="control" type="number" min="1" max="31" step="1" @input="updateFriendly">
      </label>

      <label v-if="friendly.kind !== 'interval' && friendly.kind !== 'hourly'" class="field">
        <span class="field-label">小时</span>
        <input v-model.number="friendly.hour" class="control" type="number" min="0" max="23" step="1" @input="updateFriendly">
      </label>

      <label v-if="friendly.kind !== 'interval'" class="field">
        <span class="field-label">分钟</span>
        <input v-model.number="friendly.minute" class="control" type="number" min="0" max="59" step="1" @input="updateFriendly">
      </label>

      <div class="sm:col-span-2 border-y border-line py-3">
        <span class="meta-label">Cron</span>
        <code class="mt-2 block break-all font-mono text-sm text-display">{{ schedule.expression }}</code>
      </div>
    </div>

    <label v-else class="field">
      <span class="field-label">Cron 表达式</span>
      <input :value="schedule.expression" class="control font-mono" type="text" maxlength="128" autocomplete="off" placeholder="0 9 * * *" @input="updateRaw">
      <small class="text-xs text-mute">分　时　日　月　周</small>
    </label>

    <label class="field">
      <span class="field-label">时区</span>
      <input :value="schedule.timezone" class="control" type="text" maxlength="128" list="scheduled-task-timezones" autocomplete="off" placeholder="Asia/Shanghai" @input="updateTimezone">
      <datalist id="scheduled-task-timezones">
        <option value="Asia/Shanghai"></option>
        <option value="Asia/Tokyo"></option>
        <option value="UTC"></option>
        <option value="Europe/London"></option>
        <option value="America/Los_Angeles"></option>
      </datalist>
    </label>
  </div>
</template>
