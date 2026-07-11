<script setup lang="ts">
import { RefreshCw } from "lucide-vue-next";
import { formatFullDateTime } from "../../utils/format";

defineProps<{
  primaryState: "ONLINE" | "OFFLINE" | "ERROR";
  connected: boolean;
  qqState: "online" | "offline" | "unknown";
  qq: string | number;
  nickname: string;
  connections: number;
  connectedAt?: string;
  lastEventAt?: string;
  lastMessageEventAt?: string;
  refreshing: boolean;
}>();
const emit = defineEmits<{ refresh: [] }>();
const qqStateLabel = { online: "在线", offline: "离线", unknown: "未知" } as const;
</script>

<template>
  <section class="grid gap-10 py-10 lg:grid-cols-[minmax(0,1.15fr)_minmax(360px,0.85fr)] lg:gap-16 lg:py-14">
    <div class="min-w-0">
      <p class="page-kicker">ONEBOT</p>
      <strong class="mt-3 block font-display text-[64px] font-semibold leading-none tracking-[-0.04em] md:text-[88px]" :class="connected ? 'text-display' : 'text-mute'">{{ primaryState }}</strong>
      <p class="mt-5 font-mono text-xs text-mute">
        {{ connected ? `ONEBOT 已连接 · QQ ${qqStateLabel[qqState]}` : primaryState === "ERROR" ? "状态服务不可用" : "等待 OneBot 反向 WebSocket 连接" }}
      </p>
    </div>

    <div class="min-w-0 border-t border-line lg:border-t-0">
      <div class="flex min-h-14 items-center justify-between gap-4 border-b border-line py-2">
        <div><span class="meta-label">QQ 状态</span><strong class="ml-4 text-sm font-medium" :class="qqState === 'online' ? 'text-success' : qqState === 'offline' ? 'text-warning' : 'text-mute'">{{ qqStateLabel[qqState] }}</strong></div>
        <button class="icon-btn" type="button" :disabled="refreshing" aria-label="刷新 QQ 状态" @click="emit('refresh')"><RefreshCw :size="18" :stroke-width="1.5" :class="refreshing ? 'animate-spin' : ''" /></button>
      </div>
      <div class="divider-row"><span class="meta-label">登录 QQ</span><span class="min-w-0 truncate font-mono text-xs text-display">{{ qq }}</span></div>
      <div class="divider-row"><span class="meta-label">QQ 昵称</span><span class="min-w-0 truncate text-sm text-display">{{ nickname }}</span></div>
      <div class="divider-row"><span class="meta-label">OneBot</span><span class="font-mono text-xs text-display">{{ connected ? "已连接" : "未连接" }}</span></div>
      <div class="divider-row"><span class="meta-label">连接数</span><span class="font-mono text-xs text-display">{{ connections }}</span></div>
      <div class="divider-row"><span class="meta-label">连接时间</span><span class="font-mono text-[10px] text-display">{{ formatFullDateTime(connectedAt) }}</span></div>
      <div class="divider-row"><span class="meta-label">最近事件</span><span class="font-mono text-[10px] text-display">{{ formatFullDateTime(lastEventAt) }}</span></div>
      <div class="divider-row"><span class="meta-label">最近消息</span><span class="font-mono text-[10px] text-display">{{ formatFullDateTime(lastMessageEventAt) }}</span></div>
    </div>
  </section>
</template>
