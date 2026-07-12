<script setup lang="ts">
import { computed, onMounted, shallowRef } from "vue";
import { apiRequest } from "../composables/useAdminApi";
import { useQqLogin } from "../composables/useQqLogin";
import { useRuntimeStatus } from "../composables/useRuntimeStatus";
import { formatFullDateTime } from "../utils/format";
import { formatDashboardMetric, formatExactNumber } from "../utils/numberFormat";
import type { ConversationRecord, ImageHistoryRecord, OneBotChatList, OneBotLoginCheck, OneBotLoginInfo, OneBotQrLogin, TokenUsagePayload } from "../types";
import PageHeader from "../components/ui/PageHeader.vue";
import DiagnosticsDrawer from "../components/overview/DiagnosticsDrawer.vue";
import OneBotLoginDialog from "../components/overview/OneBotLoginDialog.vue";
import OneBotChatsDrawer from "../components/overview/OneBotChatsDrawer.vue";
import OneBotStatusPanel from "../components/overview/OneBotStatusPanel.vue";
import TokenUsageDashboard from "../components/overview/TokenUsageDashboard.vue";

const runtime = useRuntimeStatus();
const loginInfo = shallowRef<OneBotLoginInfo | null>(null);
const qqStatus = shallowRef<OneBotLoginCheck | null>(null);
const chats = shallowRef<OneBotChatList | null>(null);
const conversationCount = shallowRef(0);
const imageCount = shallowRef(0);
const loadingChats = shallowRef(false);
const chatsError = shallowRef("");
const chatsOpen = shallowRef(false);
const actionMessage = shallowRef("");
const overviewError = shallowRef("");
const diagnosticsOpen = shallowRef(false);
const tokenUsage = shallowRef<TokenUsagePayload | null>(null);
const qqLogin = useQqLogin({
  onStatus(snapshot) {
    qqStatus.value = snapshot;
  },
  async onOnline() {
    await Promise.all([runtime.refresh(), loadOverviewDetails(), loadChats()]);
  }
});

const connected = computed(() => runtime.status.value?.onebot.connected ?? false);
const primaryState = computed(() => runtime.error.value && !runtime.status.value ? "ERROR" : connected.value ? "ONLINE" : "OFFLINE");
const qqIdentity = computed(() => {
  const value = loginInfo.value?.data?.user_id ?? qqStatus.value?.data?.user_id ?? runtime.status.value?.onebot.selfIds.join(", ");
  return value || "--";
});
const qqNickname = computed(() => loginInfo.value?.data?.nickname ?? qqStatus.value?.data?.nickname ?? "--");
const qqState = computed<"online" | "offline" | "unknown">(() => {
  if (!connected.value) return "offline";
  if (qqStatus.value?.error) return "unknown";
  if (!qqStatus.value) return "unknown";
  return qqStatus.value.online && Boolean(qqStatus.value.data?.user_id) ? "online" : "offline";
});
const headerMessage = computed(() => {
  if (actionMessage.value === "[REFRESHING...]") return actionMessage.value;
  if (runtime.error.value) return `[ERROR: ${runtime.error.value}]`;
  if (overviewError.value) return `[ERROR: ${overviewError.value}]`;
  return actionMessage.value;
});
const headerMessageKind = computed(() => headerMessage.value.startsWith("[ERROR") ? "error" : headerMessage.value === "[UPDATED]" ? "success" : undefined);
const countMetrics = computed(() => [
  { label: "记忆", icon: "bx-brain", value: runtime.status.value?.persona.memoryItems ?? 0, tone: "interactive" },
  { label: "会话", icon: "bx-message-square-dots", value: conversationCount.value, tone: "success" },
  { label: "图像", icon: "bx-image", value: imageCount.value, tone: "warning" }
]);

onMounted(() => {
  void loadOverviewDetails();
});

async function loadOverviewDetails() {
  const results = await Promise.allSettled([
    apiRequest<OneBotLoginCheck>("/api/onebot/qq-login/status"),
    apiRequest<OneBotLoginInfo>("/api/onebot/login-info"),
    apiRequest<{ conversations: ConversationRecord[] }>("/api/conversations"),
    apiRequest<{ images: ImageHistoryRecord[] }>("/api/images"),
    Promise.resolve().then(() => apiRequest<TokenUsagePayload>(`/api/token-usage?timezoneOffset=${new Date().getTimezoneOffset()}`))
  ]);
  if (results[0].status === "fulfilled") qqStatus.value = results[0].value;
  if (results[1].status === "fulfilled") loginInfo.value = results[1].value;
  if (results[2].status === "fulfilled") conversationCount.value = results[2].value.conversations.length;
  if (results[3].status === "fulfilled") imageCount.value = results[3].value.images.length;
  if (results[4].status === "fulfilled") tokenUsage.value = results[4].value;
  const names = ["QQ 状态", "QQ 身份", "会话", "图像", "Token"];
  overviewError.value = results.flatMap((result, index) => result.status === "rejected"
    ? [`${names[index]}: ${result.reason instanceof Error ? result.reason.message : "读取失败"}`]
    : []).join(" · ");
}

async function refreshAll() {
  actionMessage.value = "[REFRESHING...]";
  await Promise.all([runtime.refresh(), loadOverviewDetails()]);
  actionMessage.value = runtime.error.value || overviewError.value ? "" : "[UPDATED]";
}

async function loadChats() {
  loadingChats.value = true;
  chatsError.value = "";
  try {
    chats.value = await apiRequest<OneBotChatList>("/api/onebot/chats");
  } catch (error) {
    chatsError.value = error instanceof Error ? error.message : "联系人读取失败";
  } finally {
    loadingChats.value = false;
  }
}

function openChats() {
  chatsOpen.value = true;
  if (!chats.value) void loadChats();
}

async function openNapCat(route = "/api/onebot/napcat-webui-url") {
  try {
    if (/^https?:\/\//i.test(route)) {
      window.open(route, "_blank", "noopener,noreferrer");
      return;
    }
    const result = await apiRequest<{ url: string }>(route);
    window.open(result.url, "_blank", "noopener,noreferrer");
  } catch (error) {
    actionMessage.value = `[ERROR: ${error instanceof Error ? error.message : "NapCat 地址不可用"}]`;
  }
}
</script>

<template>
  <div class="page-shell">
    <div class="page-frame">
      <PageHeader kicker="OVERVIEW" title="运行状态">
        <template #actions>
          <span class="inline-state" :data-kind="headerMessageKind">{{ headerMessage }}</span>
          <button class="icon-btn" type="button" :disabled="runtime.loading.value" aria-label="刷新" @click="refreshAll"><i class="bx bx-refresh text-xl" aria-hidden="true"></i></button>
        </template>
      </PageHeader>

      <div class="mt-8 flex flex-wrap gap-2">
        <button class="btn btn-primary" type="button" @click="qqLogin.openDialog"><i class="bx bxl-qq" aria-hidden="true"></i>{{ qqState === "online" ? "QQ 账号" : "QQ 登录" }}</button>
        <button class="btn" type="button" @click="openChats"><i class="bx bx-group" aria-hidden="true"></i>联系人</button>
        <button class="btn btn-ghost" type="button" @click="openNapCat()"><i class="bx bx-link-external" aria-hidden="true"></i>NapCat</button>
        <button class="btn btn-ghost" type="button" @click="diagnosticsOpen = true"><i class="bx bx-pulse" aria-hidden="true"></i>诊断</button>
      </div>

      <OneBotStatusPanel
        class="mt-4"
        :primary-state="primaryState"
        :connected="connected"
        :qq-state="qqState"
        :qq="qqIdentity"
        :nickname="qqNickname"
        :connections="runtime.status.value?.onebot.connections ?? 0"
        :connected-at="runtime.status.value?.onebot.connectedAt"
        :last-event-at="runtime.status.value?.onebot.lastEventAt"
        :last-message-event-at="runtime.status.value?.onebot.lastMessageEventAt"
        :refreshing="runtime.loading.value || actionMessage === '[REFRESHING...]'"
        @refresh="refreshAll"
      />

      <section class="count-mosaic" aria-label="内容统计">
        <article v-for="metric in countMetrics" :key="metric.label" class="count-card" :data-tone="metric.tone">
          <span class="count-card__icon"><i class="bx" :class="metric.icon" aria-hidden="true"></i></span>
          <div class="min-w-0"><span class="meta-label">{{ metric.label }}</span><strong :title="formatExactNumber(metric.value)">{{ formatDashboardMetric(metric.value) }}</strong><small>{{ formatExactNumber(metric.value) }} 条</small></div>
        </article>
      </section>

      <TokenUsageDashboard :usage="tokenUsage" :loading="actionMessage === '[REFRESHING...]'" />

      <section class="health-mosaic" aria-label="模型与系统状态">
        <article class="health-card">
          <span class="health-card__icon"><i class="bx bx-chip" aria-hidden="true"></i></span>
          <div class="min-w-0"><span class="meta-label">Provider</span><strong>{{ runtime.status.value?.provider.defaultProviderId ?? "--" }}</strong><small>{{ runtime.status.value?.provider.model ?? "--" }}</small></div>
        </article>
        <article class="health-card">
          <span class="health-card__icon" :class="runtime.status.value?.provider.apiKeyConfigured ? 'text-success' : 'text-warning'"><i class="bx bx-key" aria-hidden="true"></i></span>
          <div class="min-w-0"><span class="meta-label">API Key</span><strong :class="runtime.status.value?.provider.apiKeyConfigured ? 'text-success' : 'text-warning'">{{ runtime.status.value?.provider.apiKeyConfigured ? "已就绪" : "未配置" }}</strong><small>{{ runtime.status.value?.provider.apiKeyConfigured ? "Provider 可调用" : "前往设置补充" }}</small></div>
        </article>
        <article class="health-card">
          <span class="health-card__icon text-success"><i class="bx bx-user-voice" aria-hidden="true"></i></span>
          <div class="min-w-0"><span class="meta-label">Agent</span><strong>{{ runtime.status.value?.persona.name ?? "--" }}</strong><small>{{ runtime.status.value?.persona.id ?? "--" }}</small></div>
        </article>
        <article class="health-card health-card--wide">
          <span class="health-card__icon text-mute"><i class="bx bx-time-five" aria-hidden="true"></i></span>
          <div class="min-w-0"><span class="meta-label">启动时间</span><strong>{{ formatFullDateTime(runtime.status.value?.startedAt) }}</strong><small class="break-all">{{ runtime.status.value?.configPath ?? "--" }}</small></div>
        </article>
      </section>

      <section v-if="runtime.status.value?.recovery?.required" class="mt-10 rounded-xl border border-accent p-5">
        <p class="inline-state" data-kind="error">[CONFIG RECOVERY REQUIRED]</p>
        <p class="mt-3 text-sm text-ink">{{ runtime.status.value.recovery.message }}</p>
        <p class="mt-2 break-all font-mono text-[10px] text-mute">{{ runtime.status.value.recovery.backupPath }}</p>
      </section>
    </div>

    <OneBotLoginDialog
      :open="qqLogin.open.value"
      :busy="qqLogin.busy.value"
      :checking="qqLogin.checking.value"
      :snapshot="qqLogin.snapshot.value"
      :error="qqLogin.error.value"
      :confirming-logout="qqLogin.confirmingLogout.value"
      @close="qqLogin.closeDialog"
      @refresh="qqLogin.refreshQrCode"
      @request-logout="qqLogin.requestLogout"
      @cancel-logout="qqLogin.cancelLogout"
      @logout="qqLogin.logout"
      @webui="openNapCat"
    />
    <OneBotChatsDrawer :open="chatsOpen" :chats="chats" :loading="loadingChats" :error="chatsError" @close="chatsOpen = false" @refresh="loadChats" />
    <DiagnosticsDrawer :open="diagnosticsOpen" @close="diagnosticsOpen = false" />
  </div>
</template>

<style scoped>
.count-mosaic { display: grid; gap: 12px; margin-top: 12px; }
.count-card, .health-card { min-width: 0; border: 1px solid rgb(var(--color-line)); border-radius: 14px; background: rgb(var(--color-panel)); }
.count-card { display: flex; min-height: 124px; align-items: center; gap: 16px; padding: 18px; }
.count-card__icon, .health-card__icon { display: grid; flex: none; place-items: center; border-radius: 10px; background: rgb(var(--color-raised)); font-size: 22px; }
.count-card__icon { width: 44px; height: 44px; color: rgb(var(--color-interactive)); }
.count-card[data-tone="success"] .count-card__icon { color: rgb(var(--color-success)); }
.count-card[data-tone="warning"] .count-card__icon { color: rgb(var(--color-warning)); }
.count-card strong { display: block; margin-top: 7px; color: rgb(var(--color-display)); font-family: "Doto", "Space Mono", monospace; font-size: 30px; font-weight: 700; line-height: .9; }
.count-card small { display: block; margin-top: 6px; color: rgb(var(--color-disabled)); font-family: "Space Mono", monospace; font-size: 9px; }
.health-mosaic { display: grid; gap: 12px; margin-top: 32px; }
.health-card { display: flex; min-height: 112px; align-items: center; gap: 14px; padding: 16px; }
.health-card__icon { width: 40px; height: 40px; color: rgb(var(--color-interactive)); }
.health-card strong { display: block; overflow: hidden; margin-top: 7px; color: rgb(var(--color-display)); font-size: 14px; font-weight: 500; text-overflow: ellipsis; white-space: nowrap; }
.health-card small { display: block; overflow: hidden; margin-top: 4px; color: rgb(var(--color-mute)); font-family: "Space Mono", monospace; font-size: 9px; text-overflow: ellipsis; white-space: nowrap; }
@media (min-width: 640px) { .count-mosaic { grid-template-columns: repeat(3, minmax(0, 1fr)); } .health-mosaic { grid-template-columns: repeat(2, minmax(0,1fr)); } }
@media (min-width: 1100px) { .health-mosaic { grid-template-columns: repeat(5, minmax(0,1fr)); } .health-card { grid-column: span 1; } .health-card--wide { grid-column: span 2; } }
</style>
