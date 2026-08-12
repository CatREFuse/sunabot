<script setup lang="ts">
import { watch } from "vue";
import type { RequestLogBusinessNode, RequestLogMemoryTool } from "../types";
import { activeAgentIdState } from "../composables/agentScope";
import { useRequestLogs } from "../composables/useRequestLogs";
import ModelCallStatsPanel from "../components/logs/ModelCallStatsPanel.vue";
import RequestLogList from "../components/logs/RequestLogList.vue";
import PageHeader from "../components/ui/PageHeader.vue";

const businessNodes: ReadonlyArray<{ id: RequestLogBusinessNode; label: string }> = [
  { id: "all", label: "全部" },
  { id: "onebot_heartbeat", label: "OneBot 心跳" },
  { id: "private_conversation", label: "私聊对话" },
  { id: "group_conversation", label: "群聊对话" },
  { id: "memory_compression", label: "记忆压缩" },
  { id: "memory_recording", label: "记忆记录" },
  { id: "dream", label: "梦境" }
];
const memoryTools: ReadonlyArray<{ id: RequestLogMemoryTool; label: string }> = [
  { id: "all", label: "全部" },
  { id: "working_memory", label: "工作记忆" },
  { id: "air", label: "读空气" },
  { id: "user_profile", label: "用户印象" }
];
const data = useRequestLogs();

watch(activeAgentIdState, () => { void data.load(1); }, { immediate: true });
</script>

<template>
  <div class="page-shell">
    <div class="page-frame">
      <PageHeader title="日志">
        <template #actions>
          <button class="icon-btn" type="button" :disabled="data.loading.value" aria-label="刷新日志" @click="data.load()">
            <i class="bx bx-refresh text-xl" :class="data.loading.value ? 'bx-spin' : ''" aria-hidden="true"></i>
          </button>
        </template>
      </PageHeader>

      <nav class="log-node-tabs" aria-label="业务节点">
        <button
          v-for="item in businessNodes"
          :key="item.id"
          class="log-node-tabs__item"
          type="button"
          role="tab"
          :aria-selected="data.node.value === item.id"
          @click="data.selectNode(item.id)"
        >
          {{ item.label }}
        </button>
      </nav>

      <div class="log-node-meta">
        <span>{{ data.total.value.toLocaleString("zh-CN") }} 条</span>
        <span>NEWEST FIRST</span>
      </div>

      <nav v-if="data.node.value === 'memory_recording'" class="memory-tool-tabs" aria-label="记忆记录类型">
        <button
          v-for="item in memoryTools"
          :key="item.id"
          class="memory-tool-tabs__item"
          type="button"
          :aria-pressed="data.memoryTool.value === item.id"
          @click="data.selectMemoryTool(item.id)"
        >
          {{ item.label }}
        </button>
      </nav>

      <ModelCallStatsPanel class="mt-6" :stats="data.stats.value" :loading="data.loading.value" />
      <p v-if="data.error.value" class="mt-6 font-mono text-xs text-accent">{{ data.error.value }}</p>
      <div v-else class="mt-6">
        <RequestLogList :logs="data.logs.value" />
        <nav v-if="data.pageCount.value > 1" class="log-pagination" aria-label="日志分页">
          <button class="btn btn-ghost" type="button" :disabled="data.loading.value || data.page.value <= 1" @click="data.previous">
            <i class="bx bx-chevron-left" aria-hidden="true"></i>上一页
          </button>
          <span>{{ data.page.value.toLocaleString("zh-CN") }} / {{ data.pageCount.value.toLocaleString("zh-CN") }}</span>
          <button class="btn btn-ghost" type="button" :disabled="data.loading.value || data.page.value >= data.pageCount.value" @click="data.next">
            下一页<i class="bx bx-chevron-right" aria-hidden="true"></i>
          </button>
        </nav>
      </div>
    </div>
  </div>
</template>

<style scoped>
.log-node-tabs {
  display: flex;
  overflow-x: auto;
  margin-top: 16px;
  border-top: 1px solid rgb(var(--color-line));
  border-bottom: 1px solid rgb(var(--color-line));
  scrollbar-width: thin;
}
.log-node-tabs__item {
  position: relative;
  min-width: max-content;
  min-height: 48px;
  padding: 0 16px;
  border-right: 1px solid rgb(var(--color-line));
  color: rgb(var(--color-mute));
  font-family: "Space Mono", monospace;
  font-size: 11px;
}
.log-node-tabs__item[aria-selected="true"] {
  color: rgb(var(--color-display));
  background: rgb(var(--color-visible) / .06);
}
.log-node-tabs__item[aria-selected="true"]::after {
  position: absolute;
  right: 0;
  bottom: -1px;
  left: 0;
  height: 2px;
  background: rgb(var(--color-display));
  content: "";
}
.log-node-meta {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  padding-top: 12px;
  color: rgb(var(--color-disabled));
  font-family: "Space Mono", monospace;
  font-size: 10px;
}
.memory-tool-tabs {
  display: flex;
  flex-wrap: wrap;
  gap: 0;
  margin-top: 20px;
  border: 1px solid rgb(var(--color-line));
}
.memory-tool-tabs__item {
  min-height: 44px;
  flex: 1 1 120px;
  padding: 0 16px;
  border-right: 1px solid rgb(var(--color-line));
  color: rgb(var(--color-mute));
  font-family: "Space Mono", monospace;
  font-size: 10px;
}
.memory-tool-tabs__item:last-child { border-right: 0; }
.memory-tool-tabs__item[aria-pressed="true"] {
  color: rgb(var(--color-display));
  background: rgb(var(--color-visible) / .08);
}
.log-pagination {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin-top: 24px;
  padding-top: 16px;
  border-top: 1px solid rgb(var(--color-line));
}
.log-pagination > span {
  color: rgb(var(--color-mute));
  font-family: "Space Mono", monospace;
  font-size: 10px;
}
@media (max-width: 560px) {
  .log-node-tabs {
    margin-right: -16px;
    margin-left: -16px;
    padding-left: 16px;
  }
  .memory-tool-tabs__item:nth-child(2) { border-right: 0; }
  .memory-tool-tabs__item:nth-child(-n+2) { border-bottom: 1px solid rgb(var(--color-line)); }
}
</style>
