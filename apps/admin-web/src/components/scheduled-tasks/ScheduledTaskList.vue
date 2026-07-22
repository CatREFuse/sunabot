<script setup lang="ts">
import { computed } from "vue";
import type { ScheduledTask, ScheduledTaskCategory } from "../../types/scheduledTasks";
import { describeSchedule, formatDateTime } from "./cronSchedule";

const props = defineProps<{
  tasks: readonly ScheduledTask[];
  category: ScheduledTaskCategory;
  loading: boolean;
  mutationBusy: boolean;
  deletingId: string;
  togglingId: string;
  retainingId: string;
  replayingId?: string;
}>();
const emit = defineEmits<{
  edit: [task: ScheduledTask];
  toggle: [task: ScheduledTask];
  togglePermanentRetention: [task: ScheduledTask];
  replay: [task: ScheduledTask];
  remove: [task: ScheduledTask];
  create: [];
}>();

const emptyLabel = computed(() => ({
  all: "还没有定时任务",
  director: "还没有导演任务",
  recurring: "还没有循环任务",
  scheduled: "还没有待触发任务",
  archived: "还没有归档任务"
}[props.category]));

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

function taskKindLabel(task: ScheduledTask) {
  if (task.archived) return "归档";
  return task.schedule.kind === "cron" ? "循环" : "定时";
}
</script>

<template>
  <section class="task-list" aria-label="定时任务表格">
    <div v-if="tasks.length" class="task-table-wrap">
      <table class="task-table">
        <thead>
          <tr>
            <th scope="col">任务</th>
            <th scope="col">计划</th>
            <th scope="col">状态</th>
            <th scope="col">触发时间</th>
            <th scope="col">目标</th>
            <th class="task-table__actions-heading" scope="col">操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="task in tasks" :key="task.id">
            <td data-label="任务">
              <div class="task-name">
                <strong>{{ task.name }}</strong>
                <p>{{ task.context }}</p>
                <p v-if="task.lastError" class="task-error">{{ task.lastError }}</p>
                <p v-if="task.deliveryAttempts">已尝试投递 {{ task.deliveryAttempts }} 次</p>
                <p v-if="task.nextDeliveryAt">下次投递 {{ formatDateTime(task.nextDeliveryAt) }}</p>
              </div>
            </td>
            <td data-label="计划">
              <span class="inline-state">{{ taskKindLabel(task) }}</span>
              <span v-if="task.director" class="inline-state">导演任务</span>
              <p class="task-mono">{{ describeSchedule(task.schedule) }}</p>
            </td>
            <td data-label="状态">
              <div class="task-states">
                <span class="inline-state" :data-kind="task.enabled && !task.archived ? 'success' : undefined">
                  {{ task.archived ? "已归档" : task.enabled ? "已启用" : "已停用" }}
                </span>
                <span
                  v-if="task.lastRunStatus"
                  class="inline-state"
                  :data-kind="task.lastRunStatus === 'failed' ? 'error' : ['completed', 'success'].includes(task.lastRunStatus) ? 'success' : undefined"
                >
                  {{ runStatusLabel(task) }}
                </span>
                <span v-if="task.permanentRetention" class="inline-state">永久保留</span>
              </div>
            </td>
            <td data-label="触发时间">
              <dl class="task-times">
                <div>
                  <dt>下次</dt>
                  <dd>{{ task.enabled ? formatDateTime(task.nextTriggerAt) : "—" }}</dd>
                </div>
                <div>
                  <dt>上次</dt>
                  <dd>{{ formatDateTime(task.lastTriggerAt) }}</dd>
                </div>
              </dl>
            </td>
            <td data-label="目标">
              <p class="task-mono">
                {{ task.targets.length }} 个会话<br>
                {{ task.targets.reduce((total, target) => total + target.mentionUserIds.length, 0) }} 个 @
              </p>
            </td>
            <td class="task-actions" data-label="操作">
              <div class="task-actions__controls">
                <button class="btn btn-ghost" type="button" :disabled="mutationBusy" @click="emit('edit', task)">编辑</button>
                <button v-if="!task.archived" class="btn" type="button" :disabled="mutationBusy" @click="emit('toggle', task)">
                  <i v-if="togglingId === task.id" class="bx bx-loader-alt bx-spin" aria-hidden="true"></i>
                  {{ togglingId === task.id ? "更新中" : task.enabled ? "停用" : "启用" }}
                </button>
                <button v-if="task.archived" class="btn" type="button" :disabled="mutationBusy" @click="emit('togglePermanentRetention', task)">
                  <i v-if="retainingId === task.id" class="bx bx-loader-alt bx-spin" aria-hidden="true"></i>
                  {{ retainingId === task.id ? "更新中" : task.permanentRetention ? "取消保留" : "永久保留" }}
                </button>
                <button v-if="task.canReplayDelivery" class="btn" type="button" :disabled="mutationBusy" @click="emit('replay', task)">
                  <i v-if="replayingId === task.id" class="bx bx-loader-alt bx-spin" aria-hidden="true"></i>
                  {{ replayingId === task.id ? "重放中" : "重放投递" }}
                </button>
                <button class="icon-btn text-accent" type="button" :disabled="mutationBusy" :aria-label="`删除 ${task.name}`" @click="emit('remove', task)">
                  <i class="bx" :class="deletingId === task.id ? 'bx-loader-alt bx-spin' : 'bx-trash'" aria-hidden="true"></i>
                </button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <div v-else class="empty-state">
      <div>
        <strong>{{ loading ? "正在读取定时任务" : emptyLabel }}</strong>
        <button v-if="!loading && category !== 'director'" class="btn btn-ghost mt-4" type="button" @click="emit('create')">
          <i class="bx bx-plus" aria-hidden="true"></i>新建任务
        </button>
      </div>
    </div>
  </section>
</template>

<style scoped>
.task-list {
  min-width: 0;
}

.task-table-wrap {
  width: 100%;
  overflow-x: auto;
}

.task-table {
  width: 100%;
  min-width: 1040px;
  border-collapse: collapse;
  table-layout: fixed;
}

.task-table th {
  height: 48px;
  border-bottom: 1px solid rgb(var(--color-visible));
  color: rgb(var(--color-mute));
  font-family: "Space Mono", monospace;
  font-size: 9px;
  font-weight: 500;
  letter-spacing: 0.06em;
  text-align: left;
}

.task-table th:nth-child(1) { width: 24%; }
.task-table th:nth-child(2) { width: 19%; }
.task-table th:nth-child(3) { width: 13%; }
.task-table th:nth-child(4) { width: 17%; }
.task-table th:nth-child(5) { width: 10%; }
.task-table th:nth-child(6) { width: 17%; }

.task-table td {
  min-width: 0;
  border-bottom: 1px solid rgb(var(--color-line));
  padding: 20px 16px 20px 0;
  color: rgb(var(--color-ink));
  font-size: 12px;
  vertical-align: top;
}

.task-table th:last-child,
.task-table td:last-child {
  padding-right: 0;
}

.task-table__actions-heading {
  text-align: right !important;
}

.task-name strong {
  display: block;
  overflow: hidden;
  color: rgb(var(--color-display));
  font-size: 14px;
  font-weight: 500;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.task-name p {
  display: -webkit-box;
  overflow: hidden;
  margin-top: 6px;
  color: rgb(var(--color-mute));
  font-size: 11px;
  line-height: 1.55;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}

.task-name .task-error {
  color: rgb(var(--color-accent));
}

.task-mono,
.task-times {
  margin-top: 8px;
  color: rgb(var(--color-ink));
  font-family: "Space Mono", monospace;
  font-size: 10px;
  line-height: 1.6;
  overflow-wrap: anywhere;
}

.task-states {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.task-times {
  display: grid;
  gap: 6px;
  margin-top: 0;
}

.task-times div {
  display: grid;
  grid-template-columns: 28px minmax(0, 1fr);
  gap: 6px;
}

.task-times dt {
  color: rgb(var(--color-mute));
}

.task-times dd {
  min-width: 0;
  overflow-wrap: anywhere;
}

.task-actions {
  text-align: right;
}

.task-actions__controls {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 8px;
}

@media (max-width: 767px) {
  .task-table-wrap {
    overflow-x: visible;
  }

  .task-table,
  .task-table tbody,
  .task-table tr,
  .task-table td {
    display: block;
    width: 100%;
    min-width: 0;
  }

  .task-table thead {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
    clip-path: inset(50%);
    white-space: nowrap;
  }

  .task-table tr {
    border-bottom: 1px solid rgb(var(--color-visible));
    padding: 16px 0;
  }

  .task-table td {
    display: grid;
    grid-template-columns: 88px minmax(0, 1fr);
    gap: 12px;
    border-bottom: 1px solid rgb(var(--color-line));
    padding: 12px 0;
  }

  .task-table td::before {
    color: rgb(var(--color-mute));
    content: attr(data-label);
    font-family: "Space Mono", monospace;
    font-size: 9px;
    letter-spacing: 0.06em;
  }

  .task-table td:first-child {
    padding-top: 0;
  }

  .task-table td:last-child {
    border-bottom: 0;
    padding-bottom: 0;
  }

  .task-actions__controls {
    min-width: 0;
    align-items: center;
    justify-content: flex-start;
  }
}
</style>
