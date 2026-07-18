<script setup lang="ts">
import { computed } from "vue";
import type { ScheduledTask } from "../../types/scheduledTasks";
import { describeSchedule, formatDateTime } from "./cronSchedule";

const props = defineProps<{
  tasks: readonly ScheduledTask[];
  loading: boolean;
  mutationBusy: boolean;
  deletingId: string;
  togglingId: string;
}>();
const emit = defineEmits<{
  edit: [task: ScheduledTask];
  toggle: [task: ScheduledTask];
  remove: [task: ScheduledTask];
  create: [];
}>();
const orderedTasks = computed(() => [...props.tasks].sort((left, right) => (
  Number(right.enabled) - Number(left.enabled)
  || (left.nextTriggerAt ?? "~").localeCompare(right.nextTriggerAt ?? "~")
  || left.name.localeCompare(right.name, "zh-CN")
)));

function runStatusLabel(task: ScheduledTask) {
  if (!task.lastRunStatus) return "尚未执行";
  return {
    pending: "等待执行",
    running: "执行中",
    generated: "等待投递",
    completed: "上次成功",
    failed: "上次失败",
    success: "上次成功"
  }[task.lastRunStatus] ?? "状态未知";
}
</script>

<template>
  <section class="mt-8 border-t border-visible" aria-label="定时任务列表">
    <article v-for="task in orderedTasks" :key="task.id" class="grid gap-5 border-b border-line py-6 lg:grid-cols-[minmax(0,1fr)_minmax(240px,0.72fr)_auto] lg:items-center">
      <div class="min-w-0">
        <div class="flex min-w-0 flex-wrap items-center gap-3">
          <h2 class="truncate text-lg font-medium text-display">{{ task.name }}</h2>
          <span class="inline-state" :data-kind="task.enabled ? 'success' : undefined">{{ task.enabled ? "已启用" : "已停用" }}</span>
          <span v-if="task.lastRunStatus" class="inline-state" :data-kind="task.lastRunStatus === 'failed' ? 'error' : ['completed', 'success'].includes(task.lastRunStatus) ? 'success' : undefined">{{ runStatusLabel(task) }}</span>
        </div>
        <p class="mt-2 line-clamp-2 max-w-3xl text-sm leading-6 text-mute">{{ task.context }}</p>
        <p v-if="task.lastError" class="mt-2 line-clamp-2 text-xs text-accent">{{ task.lastError }}</p>
      </div>

      <dl class="grid min-w-0 gap-3 sm:grid-cols-3 lg:grid-cols-1">
        <div class="min-w-0">
          <dt class="meta-label">计划</dt>
          <dd class="mt-1 break-words font-mono text-xs text-ink">{{ describeSchedule(task.schedule) }}</dd>
        </div>
        <div>
          <dt class="meta-label">目标</dt>
          <dd class="mt-1 font-mono text-xs text-ink">{{ task.targets.length }} 个会话 · {{ task.targets.reduce((total, target) => total + target.mentionUserIds.length, 0) }} 个 @</dd>
        </div>
        <div>
          <dt class="meta-label">下次触发</dt>
          <dd class="mt-1 font-mono text-xs text-ink">{{ task.enabled ? formatDateTime(task.nextTriggerAt) : "—" }}</dd>
        </div>
      </dl>

      <div class="flex flex-wrap items-center gap-2 lg:justify-end">
        <button class="btn btn-ghost" type="button" :disabled="mutationBusy" @click="emit('edit', task)">编辑</button>
        <button class="btn" type="button" :disabled="mutationBusy" @click="emit('toggle', task)">
          <i v-if="togglingId === task.id" class="bx bx-loader-alt bx-spin" aria-hidden="true"></i>
          {{ togglingId === task.id ? "更新中" : task.enabled ? "停用" : "启用" }}
        </button>
        <button class="icon-btn text-accent" type="button" :disabled="mutationBusy" :aria-label="`删除 ${task.name}`" @click="emit('remove', task)">
          <i class="bx" :class="deletingId === task.id ? 'bx-loader-alt bx-spin' : 'bx-trash'" aria-hidden="true"></i>
        </button>
      </div>
    </article>

    <div v-if="!orderedTasks.length" class="empty-state">
      <div>
        <strong>{{ loading ? "正在读取定时任务" : "还没有定时任务" }}</strong>
        <button v-if="!loading" class="btn btn-ghost mt-4" type="button" @click="emit('create')"><i class="bx bx-plus" aria-hidden="true"></i>新建任务</button>
      </div>
    </div>
  </section>
</template>
