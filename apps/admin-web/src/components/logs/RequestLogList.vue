<script setup lang="ts">
import { computed, shallowRef } from "vue";
import { requestLogPresentation } from "../../../../../packages/contracts/observability/requestLogPresentation.js";
import { formatFullDateTime } from "../../utils/format";
import {
  requestLogBusinessNodeName,
  requestLogDisplayName
} from "../../utils/logDisplay";
import { apiRequest } from "../../composables/useAdminApi";
import type { ConversationLogEntry } from "../../types";
import RequestLogDetailDialog from "./RequestLogDetailDialog.vue";
import RequestLogTokenUsage from "./RequestLogTokenUsage.vue";

const props = withDefaults(defineProps<{
  logs: readonly ConversationLogEntry[];
  enableSearch?: boolean;
}>(), { enableSearch: false });
const searchQuery = shallowRef("");
const selected = shallowRef<ConversationLogEntry | null>(null);
const selectedTrace = shallowRef<readonly ConversationLogEntry[]>([]);
const normalizedSearchQuery = computed(() => searchQuery.value.trim().toLocaleLowerCase());
const searchableLogs = computed(() => props.logs.map((log) => ({
  log,
  text: JSON.stringify(log).toLocaleLowerCase()
})));
const visibleLogs = computed(() => {
  const query = normalizedSearchQuery.value;
  if (!query) return props.logs;
  return searchableLogs.value.filter(({ text }) => text.includes(query)).map(({ log }) => log);
});

function presentation(log: ConversationLogEntry) {
  return log.presentation ?? requestLogPresentation(log as unknown as Record<string, unknown>);
}

async function openDetail(log: ConversationLogEntry) {
  selected.value = log;
  selectedTrace.value = pageTrace(log);
  if (log.category === "onebot.event") return;
  const selectedId = log.id;
  try {
    const payload = await apiRequest<{ logs: ConversationLogEntry[] }>(
      `/api/request-logs/${encodeURIComponent(selectedId)}/trace`
    );
    if (selected.value?.id === selectedId && payload.logs.length) selectedTrace.value = payload.logs;
  } catch {
    // The current page trace remains available if the bounded trace endpoint is unavailable.
  }
}

function pageTrace(log: ConversationLogEntry) {
  const runId = typeof log.metadata?.runId === "string" ? log.metadata.runId : "";
  if (!runId) return [log];
  const related = props.logs.filter((candidate) => candidate.metadata?.runId === runId);
  return related.length ? related : [log];
}

function closeDetail() {
  selected.value = null;
  selectedTrace.value = [];
}
</script>

<template>
  <section class="request-list" aria-label="请求日志列表">
    <div v-if="enableSearch && logs.length" class="request-list__search">
      <label class="sr-only" for="request-log-search">搜索请求日志</label>
      <input
        id="request-log-search"
        v-model="searchQuery"
        class="control min-w-0 flex-1"
        data-slot="request-log-search"
        type="search"
        placeholder="搜索提示词、响应或元数据"
      >
      <span class="request-list__count">{{ visibleLogs.length }} / {{ logs.length }}</span>
    </div>
    <div v-if="visibleLogs.length" class="request-list__timeline">
      <article
        v-for="log in visibleLogs"
        :key="log.id"
        class="request-list__item"
        :data-status="presentation(log).status"
        data-slot="request-log-item"
      >
        <span class="request-list__marker" data-slot="request-direction-marker" aria-hidden="true"></span>
        <button
          class="request-list__trigger"
          type="button"
          :aria-label="`查看${requestLogDisplayName(log)}请求详情`"
          @click="openDetail(log)"
        >
          <span class="request-list__main">
            <span class="request-list__meta">
              <span>{{ requestLogBusinessNodeName(log) }}</span>
              <span v-if="presentation(log).status === 'error'" class="request-list__error">[ERROR]</span>
              <span v-else-if="presentation(log).status === 'success'" class="request-list__success">[OK]</span>
              <span v-if="presentation(log).retryCount > 0 || presentation(log).willRetry" class="request-list__retry">
                RETRY {{ presentation(log).retryCount }} · {{ presentation(log).attempt }}/{{ presentation(log).maxAttempts }}
              </span>
            </span>
            <span class="request-list__title">{{ requestLogDisplayName(log) }}</span>
            <span class="request-list__action">{{ log.action }}</span>
            <span v-if="log.providerId || log.model" class="request-list__provider">
              {{ [log.providerId, log.model].filter(Boolean).join(" · ") }}
            </span>
          </span>
          <span class="request-list__aside">
            <time>{{ formatFullDateTime(log.at) }}</time>
            <span class="request-list__inspect">INSPECT <i class="bx bx-right-arrow-alt" aria-hidden="true"></i></span>
          </span>
        </button>
        <RequestLogTokenUsage v-if="log.tokenUsage" class="request-list__usage" :usage="log.tokenUsage" />
      </article>
    </div>
    <div v-else class="empty-state"><div><strong>{{ logs.length ? "没有匹配的请求日志" : "没有请求日志" }}</strong></div></div>

    <RequestLogDetailDialog
      :open="selected !== null"
      :log="selected"
      :logs="selectedTrace"
      @close="closeDetail"
    />
  </section>
</template>

<style scoped>
.request-list__search {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 16px;
}
.request-list__count {
  flex: 0 0 auto;
  color: rgb(var(--color-disabled));
  font-family: "Space Mono", monospace;
  font-size: 10px;
}
.request-list__timeline { border-top: 1px solid rgb(var(--color-line)); }
.request-list__item {
  position: relative;
  border-bottom: 1px solid rgb(var(--color-line));
}
.request-list__marker {
  position: absolute;
  top: 16px;
  bottom: 16px;
  left: 0;
  width: 2px;
  background: rgb(var(--color-mute));
}
.request-list__item[data-status="success"] .request-list__marker { background: rgb(var(--color-success)); }
.request-list__item[data-status="error"] .request-list__marker { background: rgb(var(--color-accent)); }
.request-list__trigger {
  display: grid;
  width: 100%;
  min-height: 96px;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 24px;
  padding: 16px 8px 16px 16px;
  text-align: left;
}
.request-list__trigger:hover,
.request-list__trigger:focus-visible {
  background: rgb(var(--color-visible) / .05);
}
.request-list__main {
  display: flex;
  min-width: 0;
  flex-direction: column;
  align-items: flex-start;
}
.request-list__meta {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 12px;
  font-family: "Space Mono", monospace;
  font-size: 10px;
  letter-spacing: .08em;
  color: rgb(var(--color-mute));
  text-transform: uppercase;
}
.request-list__error,
.request-list__retry { color: rgb(var(--color-accent)); }
.request-list__success { color: rgb(var(--color-success)); }
.request-list__title {
  margin-top: 10px;
  color: rgb(var(--color-display));
  font-size: 14px;
  font-weight: 500;
}
.request-list__action,
.request-list__provider,
.request-list__aside {
  font-family: "Space Mono", monospace;
  font-size: 10px;
}
.request-list__action {
  margin-top: 6px;
  overflow-wrap: anywhere;
  color: rgb(var(--color-mute));
}
.request-list__provider {
  margin-top: 4px;
  overflow-wrap: anywhere;
  color: rgb(var(--color-disabled));
}
.request-list__aside {
  display: flex;
  min-width: 128px;
  flex-direction: column;
  align-items: flex-end;
  justify-content: space-between;
  color: rgb(var(--color-disabled));
}
.request-list__inspect {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: rgb(var(--color-mute));
  letter-spacing: .08em;
}
.request-list__usage { margin: 0 8px 16px 16px; }
@media (max-width: 560px) {
  .request-list__search {
    align-items: stretch;
    flex-direction: column;
    gap: 8px;
  }
  .request-list__count { align-self: flex-end; }
  .request-list__trigger {
    min-height: 112px;
    grid-template-columns: minmax(0, 1fr);
    gap: 12px;
  }
  .request-list__aside {
    width: 100%;
    min-width: 0;
    flex-direction: row;
    align-items: center;
  }
}
</style>
