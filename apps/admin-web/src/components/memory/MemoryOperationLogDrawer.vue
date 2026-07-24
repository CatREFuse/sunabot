<script setup lang="ts">
import { formatFullDateTime } from "../../utils/format";
import type { MemoryOperationLogEntry } from "../../types";
import DialogOverlay from "../ui/DialogOverlay.vue";

defineProps<{
  open: boolean;
  logs: readonly MemoryOperationLogEntry[];
  page: number;
  pageSize: number;
  total: number;
  pageCount: number;
  loading: boolean;
  error: string;
}>();
const emit = defineEmits<{
  close: [];
  refresh: [];
  page: [page: number];
}>();

const sourceLabels: Readonly<Record<string, string>> = {
  working: "工作记忆",
  long_term: "长期记忆",
  user_profile: "用户画像",
  dream: "梦境"
};
const actorLabels: Readonly<Record<string, string>> = {
  model_tool: "模型工具",
  memory_pipeline: "记忆整理",
  admin: "管理台",
  dream: "Dream",
  system: "系统",
  memory_recall: "记忆召回"
};
const outcomeLabels: Readonly<Record<string, string>> = {
  applied: "已写入",
  unchanged: "未变化",
  rejected: "已跳过",
  conflict: "版本冲突",
  failed: "失败",
  reserved: "已预留",
  recorded: "已记录"
};
const operationLabels: Readonly<Record<string, string>> = {
  append: "追加",
  replace: "替换",
  create: "新增",
  update: "更新",
  delete: "删除",
  clear: "清空",
  merge: "合并",
  normalize: "整理",
  upsert: "写入",
  recall: "召回",
  reserve_recall: "预留召回",
  record_recall: "确认召回",
  batch_validate: "批次检查",
  batch_commit: "批次提交",
  tool_decision: "工具决定",
  dream_replace: "Dream 整理",
  dream_rollback: "Dream 回滚",
  consolidate: "Dream 合并"
};

function sourceToken(log: MemoryOperationLogEntry) {
  return log.request?.source || log.metadata?.memorySource || log.action.split(".")[0] || "";
}
function operationToken(log: MemoryOperationLogEntry) {
  return log.request?.operation || log.action.split(".").slice(1).join(".") || log.action;
}
function sourceLabel(log: MemoryOperationLogEntry) {
  const source = sourceToken(log);
  return sourceLabels[source] ?? source;
}
function operationLabel(log: MemoryOperationLogEntry) {
  const operation = operationToken(log);
  return operationLabels[operation] ?? operation;
}
function actorLabel(log: MemoryOperationLogEntry) {
  const actor = log.request?.actor ?? "";
  return actorLabels[actor] ?? actor;
}
function outcomeLabel(log: MemoryOperationLogEntry) {
  const outcome = log.response?.outcome ?? "";
  return outcomeLabels[outcome] ?? outcome;
}
function outcomeKind(log: MemoryOperationLogEntry) {
  const outcome = log.response?.outcome;
  if (outcome === "applied" || outcome === "recorded") return "success";
  if (outcome === "failed" || outcome === "conflict") return "error";
  if (outcome === "rejected") return "warning";
  return undefined;
}
function countText(log: MemoryOperationLogEntry) {
  const response = log.response;
  if (!response) return "";
  const parts = [];
  if (response.beforeCount != null || response.afterCount != null) {
    parts.push(`数量 ${response.beforeCount ?? "—"} → ${response.afterCount ?? "—"}`);
  }
  if (response.changedCount != null) parts.push(`变更 ${response.changedCount}`);
  return parts.join(" · ");
}
function hasDetails(log: MemoryOperationLogEntry) {
  return Boolean(
    log.request?.batchId
    || log.request?.recordIds?.length
    || log.response?.beforeRevision
    || log.response?.afterRevision
  );
}
</script>

<template>
  <DialogOverlay :open="open" placement="right" labelledby="memory-operation-log-title" @close="emit('close')">
    <aside class="h-full w-full max-w-xl overflow-y-auto border-l border-visible bg-panel p-4 md:p-6">
      <header class="flex items-center justify-between gap-4 border-b border-line pb-4">
        <div class="min-w-0">
          <h2 id="memory-operation-log-title" class="text-xl font-medium text-display">记忆操作日志</h2>
          <p class="mt-1 font-mono text-[10px] text-mute">{{ total.toLocaleString("zh-CN") }} 条记录</p>
        </div>
        <div class="flex shrink-0 items-center gap-2">
          <button class="btn btn-ghost" type="button" :disabled="loading" @click="emit('refresh')">刷新</button>
          <button class="btn btn-ghost" type="button" @click="emit('close')">关闭</button>
        </div>
      </header>

      <p v-if="error" class="mt-5 inline-state" data-kind="error" role="alert">{{ error }}</p>
      <p v-if="loading && !logs.length" class="py-12 text-center font-mono text-xs text-mute">加载中</p>
      <ol v-else-if="logs.length" class="mt-5 border-t border-line" aria-label="记忆操作日志列表">
        <li v-for="log in logs" :key="log.id" class="border-b border-line py-5">
          <div class="flex min-w-0 flex-wrap items-start justify-between gap-3">
            <div class="min-w-0">
              <div class="flex min-w-0 flex-wrap items-center gap-2">
                <span class="inline-state" :data-kind="outcomeKind(log)">{{ outcomeLabel(log) }}</span>
                <h3 class="text-sm font-medium text-display">{{ sourceLabel(log) }} · {{ operationLabel(log) }}</h3>
              </div>
              <p class="mt-2 font-mono text-[10px] text-mute">{{ log.action }}</p>
            </div>
            <time class="shrink-0 font-mono text-[10px] text-disabled">{{ formatFullDateTime(log.at) }}</time>
          </div>
          <dl class="mt-3 grid min-w-0 grid-cols-[max-content_1fr] gap-x-3 gap-y-2 text-xs">
            <dt class="text-disabled">执行者</dt>
            <dd class="min-w-0 break-all text-mute">{{ actorLabel(log) || "—" }}</dd>
            <template v-if="log.request?.conversationId">
              <dt class="text-disabled">会话</dt>
              <dd class="min-w-0 break-all font-mono text-[11px] text-mute">
                {{ log.request.conversationId }}<span v-if="log.request.conversationScope"> · {{ log.request.conversationScope }}</span>
              </dd>
            </template>
            <template v-if="countText(log)">
              <dt class="text-disabled">变化</dt>
              <dd class="min-w-0 text-mute">{{ countText(log) }}</dd>
            </template>
            <template v-if="log.response?.reasonCode">
              <dt class="text-disabled">原因</dt>
              <dd class="min-w-0 break-all font-mono text-[11px] text-mute">{{ log.response.reasonCode }}</dd>
            </template>
          </dl>
          <details v-if="hasDetails(log)" class="mt-3 border-t border-line pt-2">
            <summary class="flex min-h-11 cursor-pointer items-center font-mono text-[10px] text-mute">技术信息</summary>
            <dl class="grid min-w-0 grid-cols-[max-content_1fr] gap-x-3 gap-y-2 pb-2 font-mono text-[10px] text-disabled">
              <template v-if="log.request?.batchId"><dt>批次</dt><dd class="break-all">{{ log.request.batchId }}</dd></template>
              <template v-if="log.request?.recordIds?.length"><dt>记录</dt><dd class="break-all">{{ log.request.recordIds.join("、") }}</dd></template>
              <template v-if="log.response?.beforeRevision"><dt>原 revision</dt><dd class="break-all">{{ log.response.beforeRevision }}</dd></template>
              <template v-if="log.response?.afterRevision"><dt>新 revision</dt><dd class="break-all">{{ log.response.afterRevision }}</dd></template>
            </dl>
          </details>
        </li>
      </ol>
      <div v-else-if="!error" class="empty-state"><div><strong>还没有记忆操作记录</strong></div></div>

      <nav v-if="pageCount > 1" class="mt-5 flex items-center justify-between gap-3 border-t border-line pt-4" aria-label="记忆操作日志分页">
        <button class="btn btn-ghost" type="button" :disabled="loading || page <= 1" @click="emit('page', page - 1)">
          <i class="bx bx-chevron-left" aria-hidden="true"></i>上一页
        </button>
        <span class="font-mono text-[10px] text-mute">{{ page }} / {{ pageCount }} · 每页 {{ pageSize }}</span>
        <button class="btn btn-ghost" type="button" :disabled="loading || page >= pageCount" @click="emit('page', page + 1)">
          下一页<i class="bx bx-chevron-right" aria-hidden="true"></i>
        </button>
      </nav>
    </aside>
  </DialogOverlay>
</template>
