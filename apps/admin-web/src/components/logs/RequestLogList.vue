<script setup lang="ts">
import { computed, shallowRef } from "vue";
import { formatFullDateTime } from "../../utils/format";
import { requestLogDirection, requestLogDisplayName } from "../../utils/logDisplay";
import type { ConversationLogEntry } from "../../types";
import RequestLogTokenUsage from "./RequestLogTokenUsage.vue";
import StructuredValue from "./StructuredValue.vue";

const props = withDefaults(defineProps<{
  logs: readonly ConversationLogEntry[];
  enableSearch?: boolean;
}>(), { enableSearch: false });
const searchQuery = shallowRef("");
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
      <article v-for="log in visibleLogs" :key="log.id" class="request-list__item" data-slot="request-log-item">
        <span
          class="request-list__marker"
          :data-kind="log.category === 'model.response' ? 'success' : 'neutral'"
          data-slot="request-direction-marker"
          aria-hidden="true"
        ></span>
        <header class="flex min-w-0 flex-wrap items-start justify-between gap-3">
          <div class="min-w-0">
            <div class="flex min-w-0 flex-wrap items-center gap-2">
              <span class="inline-state" :data-kind="log.category === 'model.response' ? 'success' : 'neutral'">
                <i class="bx" :class="log.category === 'model.response' ? 'bx-down-arrow-alt' : 'bx-up-arrow-alt'" aria-hidden="true"></i>
                {{ requestLogDirection(log) }}
              </span>
              <h3 class="text-sm font-medium text-display">{{ requestLogDisplayName(log) }}</h3>
            </div>
            <p class="mt-2 break-all font-mono text-[10px] text-mute">{{ log.action }}</p>
            <p v-if="log.providerId || log.model" class="mt-1 break-all font-mono text-[10px] text-disabled">
              {{ [log.providerId, log.model].filter(Boolean).join(" · ") }}
            </p>
          </div>
          <time class="shrink-0 font-mono text-[10px] text-disabled">{{ formatFullDateTime(log.at) }}</time>
        </header>

        <RequestLogTokenUsage v-if="log.tokenUsage" :usage="log.tokenUsage" />

        <details v-if="log.request !== undefined" class="request-list__details">
          <summary class="request-list__summary min-h-11"><i class="bx bx-upload mr-1" aria-hidden="true"></i>请求体</summary>
          <div class="request-list__payload"><StructuredValue :value="log.request" /></div>
        </details>
        <details v-if="log.response !== undefined" class="request-list__details">
          <summary class="request-list__summary min-h-11"><i class="bx bx-download mr-1" aria-hidden="true"></i>响应体</summary>
          <div class="request-list__payload"><StructuredValue :value="log.response" /></div>
        </details>
        <details v-if="log.metadata !== undefined" class="request-list__details">
          <summary class="request-list__summary min-h-11"><i class="bx bx-info-circle mr-1" aria-hidden="true"></i>元数据</summary>
          <div class="request-list__payload"><StructuredValue :value="log.metadata" /></div>
        </details>
      </article>
    </div>
    <div v-else class="empty-state"><div><strong>{{ logs.length ? "没有匹配的请求日志" : "没有请求日志" }}</strong></div></div>
  </section>
</template>

<style scoped>
.request-list__search { display: flex; align-items: center; gap: 12px; margin-bottom: 16px; }
.request-list__count { flex: 0 0 auto; color: rgb(var(--color-disabled)); font-family: "Space Mono", monospace; font-size: 10px; }
.request-list__timeline { border-top: 1px solid rgb(var(--color-line)); }
.request-list__item { position: relative; padding: 20px 0 20px 16px; border-bottom: 1px solid rgb(var(--color-line)); }
.request-list__marker { position: absolute; top: 20px; bottom: 20px; left: 0; width: 2px; background: rgb(var(--color-mute)); }
.request-list__marker[data-kind="success"] { background: rgb(var(--color-success)); }
.request-list__details { margin-top: 12px; border-top: 1px solid rgb(var(--color-line)); padding-top: 10px; }
.request-list__summary { display: flex; align-items: center; cursor: pointer; color: rgb(var(--color-mute)); font-family: "Space Mono", monospace; font-size: 10px; }
.request-list__payload { margin-top: 10px; border-left: 2px solid rgb(var(--color-visible)); padding-left: 12px; }
@media (max-width: 560px) {
  .request-list__search { align-items: stretch; flex-direction: column; gap: 8px; }
  .request-list__count { align-self: flex-end; }
}
</style>
