<script setup lang="ts">
import { computed, reactive, shallowRef, watch } from "vue";
import type { ConversationRecord } from "../../types";
import type {
  ScheduledTask,
  ScheduledTaskInput,
  ScheduledTaskSchedule,
  ScheduledTaskTarget
} from "../../types/scheduledTasks";
import DialogOverlay from "../ui/DialogOverlay.vue";
import ToggleSwitch from "../ui/ToggleSwitch.vue";
import {
  cronExpressionError,
  defaultCronSchedule,
  isGroupConversationId,
  MAX_SCHEDULED_TASK_MENTIONS,
  validMentionUserId,
  validConversationId
} from "./cronSchedule";
import ScheduleEditor from "./ScheduleEditor.vue";
import ScheduledTaskTargetsEditor from "./ScheduledTaskTargetsEditor.vue";

const props = defineProps<{
  open: boolean;
  task: ScheduledTask | null;
  conversations: readonly ConversationRecord[];
  busy: boolean;
  error: string;
}>();
const emit = defineEmits<{
  close: [];
  save: [input: ScheduledTaskInput];
}>();
const draft = reactive<ScheduledTaskInput>(emptyInput());
const localError = shallowRef("");
const title = computed(() => props.task ? "编辑定时任务" : "新建定时任务");

watch(
  [() => props.open, () => props.task],
  () => {
    if (!props.open) return;
    replaceDraft(props.task ? inputFromTask(props.task) : emptyInput());
    localError.value = "";
  },
  { immediate: true }
);

function updateSchedule(schedule: ScheduledTaskSchedule) {
  draft.schedule = schedule;
  localError.value = "";
}

function updateTargets(targets: ScheduledTaskTarget[]) {
  draft.targets = targets;
  localError.value = "";
}

function submit() {
  const error = validateDraft(draft);
  if (error) {
    localError.value = error;
    return;
  }
  emit("save", normalizedDraft(draft));
}

function replaceDraft(input: ScheduledTaskInput) {
  draft.name = input.name;
  draft.enabled = input.enabled;
  draft.context = input.context;
  draft.schedule = cloneSchedule(input.schedule);
  draft.targets = input.targets.map((target) => ({
    conversationId: target.conversationId,
    mentionUserIds: [...target.mentionUserIds]
  }));
}

function emptyInput(): ScheduledTaskInput {
  return {
    name: "",
    enabled: true,
    context: "",
    schedule: defaultCronSchedule(),
    targets: [{ conversationId: "", mentionUserIds: [] }]
  };
}

function inputFromTask(task: ScheduledTask): ScheduledTaskInput {
  return {
    name: task.name,
    enabled: task.enabled,
    context: task.context,
    schedule: cloneSchedule(task.schedule),
    targets: task.targets.map((target) => ({
      conversationId: target.conversationId,
      mentionUserIds: [...target.mentionUserIds]
    }))
  };
}

function cloneSchedule(schedule: ScheduledTaskSchedule): ScheduledTaskSchedule {
  return schedule.kind === "cron" ? { ...schedule } : { ...schedule };
}

function validateDraft(input: ScheduledTaskInput) {
  if (!input.name.trim()) return "请输入任务名称";
  if (!input.context.trim()) return "请输入任务上下文";
  if (input.schedule.kind === "cron") {
    const expressionError = cronExpressionError(input.schedule.expression);
    if (expressionError) return expressionError;
    if (!input.schedule.timezone.trim()) return "请输入时区";
  } else if (!input.schedule.runAt || Number.isNaN(new Date(input.schedule.runAt).getTime())) {
    return "请选择有效的执行时间";
  }
  if (!input.targets.length) return "请添加至少一个回调会话";
  const conversationIds = new Set<string>();
  for (const target of input.targets) {
    const conversationId = target.conversationId.trim();
    if (!validConversationId(conversationId)) return "回调会话 ID 无效";
    if (conversationIds.has(conversationId)) return "回调会话不能重复";
    conversationIds.add(conversationId);
    if (!isGroupConversationId(conversationId) && target.mentionUserIds.length) return "私聊回调不能设置 @ 对象";
    if (target.mentionUserIds.length > MAX_SCHEDULED_TASK_MENTIONS) return `每个会话最多添加 ${MAX_SCHEDULED_TASK_MENTIONS} 个 @ 对象`;
    if (target.mentionUserIds.some((id) => !validMentionUserId(id))) return "@ 对象必须使用有效 QQ 号";
    if (new Set(target.mentionUserIds).size !== target.mentionUserIds.length) return "同一会话的 @ 对象不能重复";
  }
  return "";
}

function normalizedDraft(input: ScheduledTaskInput): ScheduledTaskInput {
  return {
    name: input.name.trim(),
    enabled: input.enabled,
    context: input.context.trim(),
    schedule: input.schedule.kind === "cron"
      ? {
          kind: "cron",
          expression: input.schedule.expression.trim().replace(/\s+/g, " "),
          timezone: input.schedule.timezone.trim()
        }
      : { kind: "once", runAt: input.schedule.runAt },
    targets: input.targets.map((target) => ({
      conversationId: target.conversationId.trim(),
      mentionUserIds: [...new Set(target.mentionUserIds.map((id) => id.trim()))]
    }))
  };
}
</script>

<template>
  <DialogOverlay :open="open" class="!p-0 sm:!p-4" labelledby="scheduled-task-editor-title" :dismissible="!busy" @close="emit('close')">
    <form class="flex h-[100dvh] min-h-0 max-h-[100dvh] w-full max-w-3xl flex-col overflow-hidden border-visible bg-panel sm:h-auto sm:max-h-[calc(100dvh-32px)] sm:rounded sm:border" @submit.prevent="submit">
      <header class="flex items-center justify-between gap-4 border-b border-line p-4 md:p-5">
        <h2 id="scheduled-task-editor-title" class="min-w-0 truncate text-xl font-medium text-display">{{ title }}</h2>
        <button class="icon-btn" type="button" :disabled="busy" aria-label="关闭" @click="emit('close')"><i class="bx bx-x text-2xl" aria-hidden="true"></i></button>
      </header>

      <div class="grid min-h-0 flex-1 content-start gap-8 overflow-y-auto p-4 md:p-6">
        <section class="grid gap-5" aria-labelledby="scheduled-task-basic-title">
          <h3 id="scheduled-task-basic-title" class="text-base font-medium text-display">任务内容</h3>
          <label class="field">
            <span class="field-label">名称</span>
            <input v-model="draft.name" class="control" type="text" maxlength="120" autocomplete="off" data-dialog-initial-focus placeholder="每日工作提醒">
          </label>
          <label class="field">
            <span class="field-label">上下文</span>
            <textarea v-model="draft.context" class="control min-h-32" maxlength="32000" placeholder="说明任务背景、目标和回复要求"></textarea>
          </label>
          <div class="border-y border-line py-1">
            <ToggleSwitch v-model="draft.enabled" label="启用任务" />
          </div>
        </section>

        <ScheduleEditor :model-value="draft.schedule" @update:model-value="updateSchedule" />
        <ScheduledTaskTargetsEditor :targets="draft.targets" :conversations="conversations" @update="updateTargets" />

        <p v-if="localError || error" class="inline-state" data-kind="error" role="alert">{{ localError || error }}</p>
      </div>

      <footer class="flex flex-wrap justify-end gap-2 border-t border-line p-4 md:p-5" data-slot="dialog-actions">
        <button class="btn btn-ghost" type="button" :disabled="busy" @click="emit('close')">取消</button>
        <button class="btn btn-primary" type="submit" :disabled="busy">
          <i class="bx" :class="busy ? 'bx-loader-alt bx-spin' : 'bx-check'" aria-hidden="true"></i>{{ busy ? "保存中" : "保存" }}
        </button>
      </footer>
    </form>
  </DialogOverlay>
</template>
