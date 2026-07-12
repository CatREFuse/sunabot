<script setup lang="ts">
import { formatFullDateTime } from "../../utils/format";
import { requestLogDirection, requestLogDisplayName } from "../../utils/logDisplay";
import type { ConversationLogEntry } from "../../types";
import RequestLogTokenUsage from "./RequestLogTokenUsage.vue";
import StructuredValue from "./StructuredValue.vue";

defineProps<{ logs: readonly ConversationLogEntry[] }>();
</script>

<template>
  <section class="request-list" aria-label="请求日志列表">
    <div v-if="logs.length" class="request-list__timeline">
      <article v-for="log in logs" :key="log.id" class="request-list__item">
        <span
          class="request-list__marker"
          :data-kind="log.category === 'model.response' ? 'success' : 'neutral'"
          aria-hidden="true"
        >
          <i class="bx" :class="log.category === 'model.response' ? 'bx-down-arrow-alt' : 'bx-up-arrow-alt'"></i>
        </span>
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
          <summary><i class="bx bx-upload mr-1" aria-hidden="true"></i>请求体</summary>
          <div class="request-list__payload"><StructuredValue :value="log.request" /></div>
        </details>
        <details v-if="log.response !== undefined" class="request-list__details">
          <summary><i class="bx bx-download mr-1" aria-hidden="true"></i>响应体</summary>
          <div class="request-list__payload"><StructuredValue :value="log.response" /></div>
        </details>
        <details v-if="log.metadata !== undefined" class="request-list__details">
          <summary><i class="bx bx-info-circle mr-1" aria-hidden="true"></i>元数据</summary>
          <div class="request-list__payload"><StructuredValue :value="log.metadata" /></div>
        </details>
      </article>
    </div>
    <div v-else class="empty-state"><div><strong>没有请求日志</strong></div></div>
  </section>
</template>

<style scoped>
.request-list__timeline { position: relative; padding-left: 40px; border-top: 1px solid rgb(var(--color-line)); }
.request-list__timeline::before { content: ""; position: absolute; top: 24px; bottom: 24px; left: 11px; width: 1px; background: rgb(var(--color-visible)); }
.request-list__item { position: relative; padding: 20px 0; border-bottom: 1px solid rgb(var(--color-line)); }
.request-list__marker { position: absolute; top: 20px; left: 0; z-index: 1; display: grid; width: 24px; height: 24px; place-items: center; transform: translateX(-40px); border: 1px solid currentColor; border-radius: 50%; background: rgb(var(--color-page)); color: rgb(var(--color-mute)); font-size: 17px; }
.request-list__marker[data-kind="success"] { color: rgb(var(--color-success)); }
.request-list__details { margin-top: 12px; border-top: 1px solid rgb(var(--color-line)); padding-top: 10px; }
.request-list__details summary { cursor: pointer; color: rgb(var(--color-mute)); font-family: "Space Mono", monospace; font-size: 10px; }
.request-list__payload { margin-top: 10px; border-left: 2px solid rgb(var(--color-visible)); padding-left: 12px; }
@media (max-width: 560px) {
  .request-list__timeline { padding-left: 32px; }
  .request-list__timeline::before { left: 9px; }
  .request-list__marker { width: 20px; height: 20px; transform: translateX(-32px); font-size: 15px; }
}
</style>
