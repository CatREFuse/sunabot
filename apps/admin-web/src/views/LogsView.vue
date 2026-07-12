<script setup lang="ts">
import { onMounted, shallowRef } from "vue";
import { useRequestLogs } from "../composables/useRequestLogs";
import PageHeader from "../components/ui/PageHeader.vue";
import ActivityTerminal from "../components/logs/ActivityTerminal.vue";
import RequestLogList from "../components/logs/RequestLogList.vue";

const active = shallowRef<"terminal" | "requests">("terminal");
const data = useRequestLogs();
onMounted(() => data.load());
</script>

<template>
  <div class="page-shell">
    <div class="page-frame">
      <PageHeader kicker="ACTIVITY" title="日志">
        <template #actions><button class="icon-btn" type="button" :disabled="data.loading.value" aria-label="刷新日志" @click="data.load()"><i class="bx bx-refresh text-xl" :class="data.loading.value ? 'bx-spin' : ''" aria-hidden="true"></i></button></template>
      </PageHeader>
      <div class="mt-4 flex flex-wrap items-center justify-between gap-4 border-b border-line pb-4">
        <div class="segmented" aria-label="日志视图">
          <button class="segmented-button" type="button" :aria-pressed="active === 'terminal'" @click="active = 'terminal'"><i class="bx bx-terminal mr-1" aria-hidden="true"></i>活动终端</button>
          <button class="segmented-button" type="button" :aria-pressed="active === 'requests'" @click="active = 'requests'"><i class="bx bx-list-ul mr-1" aria-hidden="true"></i>请求日志</button>
        </div>
        <span class="font-mono text-[10px] text-mute">{{ data.total.value.toLocaleString("zh-CN") }} 条 · NEWEST FIRST</span>
      </div>
      <p v-if="data.error.value" class="mt-6 font-mono text-xs text-accent">[ERROR: {{ data.error.value }}]</p>
      <div v-else class="mt-6">
        <ActivityTerminal v-if="active === 'terminal'" :logs="data.logs.value" :events="data.events.value" />
        <RequestLogList v-else :logs="data.logs.value" />
        <nav v-if="data.pageCount.value > 1" class="mt-6 flex items-center justify-between gap-4 border-t border-line pt-4" aria-label="日志分页">
          <button class="btn btn-ghost" type="button" :disabled="data.loading.value || data.page.value <= 1" @click="data.previous"><i class="bx bx-chevron-left" aria-hidden="true"></i>上一页</button>
          <span class="font-mono text-[10px] text-mute">{{ data.page.value.toLocaleString("zh-CN") }} / {{ data.pageCount.value.toLocaleString("zh-CN") }}</span>
          <button class="btn btn-ghost" type="button" :disabled="data.loading.value || data.page.value >= data.pageCount.value" @click="data.next">下一页<i class="bx bx-chevron-right" aria-hidden="true"></i></button>
        </nav>
      </div>
    </div>
  </div>
</template>
