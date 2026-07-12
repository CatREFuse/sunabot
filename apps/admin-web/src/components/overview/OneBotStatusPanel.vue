<script setup lang="ts">
import { computed } from "vue";
import { formatFullDateTime } from "../../utils/format";
import { formatDashboardMetric, formatExactNumber } from "../../utils/numberFormat";
import IdentityAvatar from "../ui/IdentityAvatar.vue";

const props = defineProps<{
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
const avatar = computed(() => /^\d{5,12}$/.test(String(props.qq)) ? `/api/media/qq-avatar?kind=user&id=${props.qq}` : "");
const emit = defineEmits<{ refresh: [] }>();
const qqStateLabel = { online: "在线", offline: "离线", unknown: "未知" } as const;
const stateKind = computed(() => props.primaryState === "ONLINE" ? "success" : props.primaryState === "ERROR" ? "error" : "warning");
const stateIcon = computed(() => props.primaryState === "ONLINE" ? "bx-check-shield" : props.primaryState === "ERROR" ? "bx-error" : "bx-wifi-off");
</script>

<template>
  <section class="connection-mosaic" aria-label="运行与 QQ 状态">
    <article class="dashboard-card runtime-card" :data-state="stateKind">
      <header class="dashboard-card__header">
        <span class="meta-label"><i class="bx bx-radio-circle-marked mr-1" aria-hidden="true"></i>Core / OneBot</span>
        <span class="inline-state" :data-kind="stateKind"><i class="bx" :class="stateIcon" aria-hidden="true"></i>{{ connected ? "运行正常" : primaryState === "ERROR" ? "状态异常" : "等待连接" }}</span>
      </header>
      <div class="runtime-card__body">
        <strong class="runtime-card__state">{{ primaryState }}</strong>
        <p :class="stateKind === 'success' ? 'text-success' : stateKind === 'error' ? 'text-accent' : 'text-warning'">
          <i class="bx" :class="stateIcon" aria-hidden="true"></i>
          {{ connected ? `OneBot 已连接，QQ ${qqStateLabel[qqState]}` : primaryState === "ERROR" ? "状态服务不可用" : "等待反向 WebSocket" }}
        </p>
      </div>
      <footer class="runtime-card__footer">
        <span><i class="bx bx-git-compare" aria-hidden="true"></i><strong :title="formatExactNumber(connections)">{{ formatDashboardMetric(connections) }}</strong> 个连接</span>
        <span><i class="bx bx-message-rounded-dots" aria-hidden="true"></i>{{ formatFullDateTime(lastMessageEventAt) }}</span>
      </footer>
    </article>

    <article class="dashboard-card identity-card">
      <header class="dashboard-card__header">
        <span class="meta-label"><i class="bx bxl-qq mr-1" aria-hidden="true"></i>QQ Bot</span>
        <button class="icon-btn" type="button" :disabled="refreshing" aria-label="刷新 QQ 状态" @click="emit('refresh')"><i class="bx bx-refresh text-xl" :class="refreshing ? 'bx-spin' : ''" aria-hidden="true"></i></button>
      </header>
      <div class="identity-card__profile">
        <span class="identity-card__brand" aria-hidden="true"><i class="bx bxl-qq"></i></span>
        <IdentityAvatar :src="avatar" :name="nickname" size="lg" />
        <div class="min-w-0">
          <strong class="block truncate text-lg font-medium text-display">{{ nickname }}</strong>
          <span class="mt-1 block truncate font-mono text-[10px] text-mute">QQ {{ qq }}</span>
        </div>
        <span class="inline-state ml-auto" :data-kind="qqState === 'online' ? 'success' : qqState === 'offline' ? 'warning' : undefined"><i class="bx" :class="qqState === 'online' ? 'bx-check-circle' : 'bx-minus-circle'" aria-hidden="true"></i>{{ qqStateLabel[qqState] }}</span>
      </div>
      <dl class="identity-card__facts">
        <div><dt><i class="bx bx-link" aria-hidden="true"></i>连接于</dt><dd>{{ formatFullDateTime(connectedAt) }}</dd></div>
        <div><dt><i class="bx bx-pulse" aria-hidden="true"></i>最近事件</dt><dd>{{ formatFullDateTime(lastEventAt) }}</dd></div>
      </dl>
    </article>
  </section>
</template>

<style scoped>
.connection-mosaic { display: grid; gap: 16px; }
.dashboard-card { min-width: 0; overflow: hidden; border: 1px solid rgb(var(--color-line)); border-radius: 14px; background: rgb(var(--color-panel)); }
.dashboard-card__header { display: flex; min-height: 52px; align-items: center; justify-content: space-between; gap: 12px; border-bottom: 1px solid rgb(var(--color-line)); padding: 8px 16px; }
.runtime-card { position: relative; }
.runtime-card::before { position: absolute; top: 0; bottom: 0; left: 0; width: 3px; background: rgb(var(--color-warning)); content: ""; }
.runtime-card[data-state="success"]::before { background: rgb(var(--color-success)); }
.runtime-card[data-state="error"]::before { background: rgb(var(--color-accent)); }
.runtime-card__body { padding: 24px 20px 28px; }
.runtime-card__state { display: block; font-family: "Doto", "Space Mono", monospace; font-size: clamp(42px, 7vw, 64px); font-weight: 700; line-height: .9; letter-spacing: -.045em; color: rgb(var(--color-display)); }
.runtime-card__body p { display: flex; align-items: center; gap: 8px; margin-top: 18px; font-family: "Space Mono", monospace; font-size: 11px; }
.runtime-card__footer { display: grid; gap: 1px; border-top: 1px solid rgb(var(--color-line)); background: rgb(var(--color-line)); }
.runtime-card__footer span { display: flex; min-width: 0; align-items: center; gap: 8px; background: rgb(var(--color-panel)); padding: 12px 16px; color: rgb(var(--color-mute)); font-family: "Space Mono", monospace; font-size: 10px; overflow-wrap: anywhere; }
.runtime-card__footer strong { color: rgb(var(--color-display)); font-size: 13px; }
.identity-card__profile { display: flex; min-height: 112px; align-items: center; gap: 12px; padding: 20px 16px; }
.identity-card__brand { display: none; color: rgb(var(--color-interactive)); font-size: 28px; }
.identity-card__facts { border-top: 1px solid rgb(var(--color-line)); }
.identity-card__facts div { display: grid; grid-template-columns: 104px minmax(0,1fr); gap: 12px; border-bottom: 1px solid rgb(var(--color-line)); padding: 12px 16px; }
.identity-card__facts div:last-child { border-bottom: 0; }
.identity-card__facts dt { display: flex; align-items: center; gap: 6px; color: rgb(var(--color-mute)); font-family: "Space Mono", monospace; font-size: 10px; }
.identity-card__facts dd { min-width: 0; overflow-wrap: anywhere; color: rgb(var(--color-ink)); font-family: "Space Mono", monospace; font-size: 10px; text-align: right; }
@media (min-width: 640px) { .runtime-card__footer { grid-template-columns: 1fr 1.4fr; } .identity-card__brand { display: block; } }
@media (min-width: 900px) { .connection-mosaic { grid-template-columns: minmax(0, 1.25fr) minmax(340px, .75fr); } }
</style>
