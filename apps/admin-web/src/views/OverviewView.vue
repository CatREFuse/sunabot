<script setup lang="ts">
import { computed, onMounted, shallowRef, watch } from "vue";
import { useRouter } from "vue-router";
import { apiRequest } from "../composables/useAdminApi";
import { useQqLogin } from "../composables/useQqLogin";
import { useRuntimeStatus } from "../composables/useRuntimeStatus";
import { useAgents } from "../composables/useAgents";
import { formatFullDateTime } from "../utils/format";
import { formatDashboardMetric, formatExactNumber } from "../utils/numberFormat";
import type { AgentAccount, OneBotChatList, OneBotLoginCheck, TokenUsageFilters, TokenUsagePayload } from "../types";
import PageHeader from "../components/ui/PageHeader.vue";
import DiagnosticsDrawer from "../components/overview/DiagnosticsDrawer.vue";
import OneBotLoginDialog from "../components/overview/OneBotLoginDialog.vue";
import OneBotChatsDrawer from "../components/overview/OneBotChatsDrawer.vue";
import OneBotStatusPanel from "../components/overview/OneBotStatusPanel.vue";
import TokenUsageDashboard from "../components/overview/TokenUsageDashboard.vue";

const runtime = useRuntimeStatus();
const agentsState = useAgents();
const router = useRouter();
const usageScope = shallowRef<"all" | "agent">("agent");
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
const tokenUsageModel = shallowRef("");
const tokenUsageBehavior = shallowRef<TokenUsageFilters["behavior"]>("");
const tokenUsageLoading = shallowRef(false);
const selectedAccountId = shallowRef("");
const loginAccount = shallowRef<AgentAccount | null>(null);
let tokenUsageRequestId = 0;
let overviewMounted = false;
const currentAccounts = computed(() => agentsState.currentAgent.value?.accounts ?? []);
const accountCatalogKey = computed(() => `${agentsState.currentAgent.value?.id ?? ""}:${currentAccounts.value.map((account) => account.id).join("|")}`);
const selectedAccount = computed(() => currentAccounts.value.find((account) => account.id === selectedAccountId.value));
const selectedAccountKey = computed(() => accountKey(selectedAccount.value));
const qqLogin = useQqLogin({
  paths: () => accountLoginPaths(loginAccount.value),
  onStatus(snapshot) {
    if (accountKey(loginAccount.value ?? undefined) === selectedAccountKey.value) qqStatus.value = snapshot;
  },
  async onOnline() {
    await Promise.all([runtime.refresh(), loadOverviewDetails(), loadChats()]);
  }
});

watch(accountCatalogKey, syncSelectedAccount, { immediate: true });
watch(selectedAccountKey, (next, previous) => {
  if (next === previous) return;
  qqStatus.value = null;
  chats.value = null;
  chatsError.value = "";
  chatsOpen.value = false;
  loadingChats.value = false;
  overviewError.value = "";
  if (qqLogin.open.value) closeQqLogin();
  if (overviewMounted) void loadSelectedAccountStatus();
});

const runtimeConnected = computed(() => runtime.status.value?.onebot.connected ?? false);
const accountConnected = computed(() => qqStatus.value?.connected ?? selectedAccount.value?.connected ?? false);
const primaryState = computed(() => runtime.error.value && !runtime.status.value ? "ERROR" : runtimeConnected.value ? "ONLINE" : "OFFLINE");
const qqIdentity = computed(() => {
  const value = qqStatus.value?.data?.user_id ?? selectedAccount.value?.qqId;
  return value || "--";
});
const qqNickname = computed(() => qqStatus.value?.data?.nickname ?? selectedAccount.value?.label ?? "--");
const qqState = computed<"online" | "offline" | "unknown">(() => {
  if (!selectedAccount.value || !accountConnected.value) return "offline";
  if (qqStatus.value?.error) return "unknown";
  if (!qqStatus.value) return "unknown";
  return qqStatus.value.online && Boolean(qqStatus.value.data?.user_id) ? "online" : "offline";
});
const headerMessage = computed(() => {
  if (actionMessage.value === "刷新中") return actionMessage.value;
  if (runtime.error.value) return runtime.error.value;
  if (overviewError.value) return overviewError.value;
  return actionMessage.value;
});
const headerMessageKind = computed(() => {
  if (runtime.error.value || overviewError.value) return "error";
  if (headerMessage.value === "已更新") return "success";
  if (headerMessage.value && headerMessage.value !== "刷新中") return "error";
  return undefined;
});
const countMetrics = computed(() => usageScope.value === "all" ? [
  { label: "Agent", icon: "bx-bot", value: agentsState.agents.value.length, tone: "interactive" },
  { label: "在线 Agent", icon: "bx-pulse", value: agentsState.agents.value.filter((agent) => agent.accounts.some((account) => account.connected)).length, tone: "success" },
  { label: "在线 QQ", icon: "bxl-qq", value: agentsState.agents.value.flatMap((agent) => agent.accounts).filter((account) => account.connected).length, tone: "warning" }
] : [
  { label: "记忆", icon: "bx-brain", value: runtime.status.value?.persona.memoryItems ?? 0, tone: "interactive" },
  { label: "会话", icon: "bx-message-square-dots", value: conversationCount.value, tone: "success" },
  { label: "图像", icon: "bx-image", value: imageCount.value, tone: "warning" }
]);
const providerProbe = computed(() => runtime.status.value?.probe?.checks.find((check) => check.id === "provider"));
const providerReadiness = computed(() => {
  const provider = runtime.status.value?.provider;
  if (providerProbe.value?.status === "pass") {
    return { label: "已验证可用", detail: "连接正常", tone: "text-success" };
  }
  const configured = provider?.configured ?? provider?.apiKeyConfigured ?? false;
  if (!providerProbe.value && provider?.verifiedAvailable === true) {
    return { label: "已验证可用", detail: "连接正常", tone: "text-success" };
  }
  if (configured) {
    return { label: "当前不可用", detail: "已配置", tone: "text-warning" };
  }
  return { label: "未配置", detail: "前往设置", tone: "text-warning" };
});

onMounted(async () => {
  await agentsState.load().catch(() => undefined);
  syncSelectedAccount();
  overviewMounted = true;
  await loadOverviewDetails();
});

async function loadOverviewDetails() {
  const statusAccount = selectedAccount.value;
  const statusAccountKey = accountKey(statusAccount);
  const results = await Promise.allSettled([
    statusAccount
      ? apiRequest<OneBotLoginCheck>(`${accountApiBaseFor(statusAccount)}/login/status`)
      : Promise.resolve({ connected: false, online: false } as OneBotLoginCheck),
    apiRequest<{ conversations: number; images: number }>("/api/overview/summary"),
    Promise.resolve().then(() => apiRequest<TokenUsagePayload>(tokenUsageUrl()))
  ]);
  if (results[0].status === "fulfilled" && selectedAccountKey.value === statusAccountKey) qqStatus.value = results[0].value;
  if (results[1].status === "fulfilled") {
    conversationCount.value = results[1].value.conversations;
    imageCount.value = results[1].value.images;
  }
  if (results[2].status === "fulfilled") tokenUsage.value = results[2].value;
  const names = ["QQ 状态", "概览", "Token"];
  overviewError.value = results.flatMap((result, index) => result.status === "rejected"
    && (index !== 0 || selectedAccountKey.value === statusAccountKey)
    ? [`${names[index]}: ${result.reason instanceof Error ? result.reason.message : "读取失败"}`]
    : []).join(" · ");
}

async function loadSelectedAccountStatus() {
  const account = selectedAccount.value;
  const key = accountKey(account);
  if (!account) {
    qqStatus.value = null;
    return;
  }
  try {
    const result = await apiRequest<OneBotLoginCheck>(`${accountApiBaseFor(account)}/login/status`);
    if (selectedAccountKey.value === key) qqStatus.value = result;
  } catch (error) {
    if (selectedAccountKey.value === key) overviewError.value = `QQ 状态: ${error instanceof Error ? error.message : "读取失败"}`;
  }
}

function tokenUsageUrl() {
  const query = new URLSearchParams({ timezoneOffset: String(new Date().getTimezoneOffset()) });
  if (usageScope.value === "all") query.set("agentId", "all");
  if (tokenUsageModel.value) query.set("model", tokenUsageModel.value);
  if (tokenUsageBehavior.value) query.set("behavior", tokenUsageBehavior.value);
  return `/api/token-usage?${query}`;
}

async function setUsageScope(scope: "all" | "agent") {
  usageScope.value = scope;
  tokenUsageModel.value = "";
  tokenUsageBehavior.value = "";
  await loadOverviewDetails();
}

async function applyTokenUsageFilters(filters: TokenUsageFilters) {
  tokenUsageModel.value = filters.model;
  tokenUsageBehavior.value = filters.behavior;
  const requestId = ++tokenUsageRequestId;
  tokenUsageLoading.value = true;
  try {
    const result = await apiRequest<TokenUsagePayload>(tokenUsageUrl());
    if (requestId === tokenUsageRequestId) tokenUsage.value = result;
  } catch (error) {
    if (requestId === tokenUsageRequestId) {
      overviewError.value = `Token: ${error instanceof Error ? error.message : "读取失败"}`;
    }
  } finally {
    if (requestId === tokenUsageRequestId) tokenUsageLoading.value = false;
  }
}

async function refreshAll() {
  actionMessage.value = "刷新中";
  await Promise.all([runtime.refresh(), loadOverviewDetails()]);
  actionMessage.value = runtime.error.value || overviewError.value ? "" : "已更新";
}

async function loadChats() {
  const account = selectedAccount.value;
  const key = accountKey(account);
  loadingChats.value = true;
  chatsError.value = "";
  try {
    const result = account
      ? await apiRequest<OneBotChatList>(`${accountApiBaseFor(account)}/chats`)
      : { connected: false, private: [], groups: [] };
    if (selectedAccountKey.value === key) chats.value = result;
  } catch (error) {
    if (selectedAccountKey.value === key) chatsError.value = error instanceof Error ? error.message : "联系人读取失败";
  } finally {
    if (selectedAccountKey.value === key) loadingChats.value = false;
  }
}

function openChats() {
  chatsOpen.value = true;
  if (!chats.value) void loadChats();
}

function openAccount() {
  const account = selectedAccount.value;
  if (!account) {
    void router.push("/agents");
    return;
  }
  loginAccount.value = account;
  void qqLogin.openDialog();
}

function closeQqLogin() {
  qqLogin.closeDialog();
  loginAccount.value = null;
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
    actionMessage.value = error instanceof Error ? error.message : "NapCat 地址不可用";
  }
}

function openCurrentNapCat() {
  const account = selectedAccount.value;
  if (!account) {
    actionMessage.value = "还没有 QQ 账号";
    return;
  }
  void openNapCat(`${accountApiBaseFor(account)}/napcat-webui-url`);
}

function syncSelectedAccount() {
  const accounts = currentAccounts.value;
  if (accounts.some((account) => account.id === selectedAccountId.value)) return;
  selectedAccountId.value = accounts.find((account) => account.id === "primary")?.id ?? accounts[0]?.id ?? "";
}

function accountKey(account: AgentAccount | undefined) {
  return account ? `${account.agentId}:${account.id}` : "";
}

function accountApiBaseFor(account: AgentAccount) {
  return `/api/agents/${encodeURIComponent(account.agentId)}/accounts/${encodeURIComponent(account.id)}`;
}

function accountLoginPaths(account: AgentAccount | null) {
  if (!account) throw new Error("请先选择 QQ 账号");
  const base = accountApiBaseFor(account);
  return { status: `${base}/login/status`, login: `${base}/login`, logout: `${base}/logout` };
}

function accountOptionLabel(account: AgentAccount) {
  if (account.id === "primary") return `${account.label} · primary`;
  return `${account.label} · ${account.id}`;
}
</script>

<template>
  <div class="page-shell">
    <div class="page-frame">
      <PageHeader title="运行状态">
        <template #actions>
          <span class="inline-state" :data-kind="headerMessageKind">{{ headerMessage }}</span>
          <button class="icon-btn" type="button" :disabled="runtime.loading.value" aria-label="刷新" @click="refreshAll"><i class="bx bx-refresh text-xl" aria-hidden="true"></i></button>
        </template>
      </PageHeader>

      <div class="mt-6 segmented" aria-label="统计范围">
        <button class="segmented-button" type="button" :aria-pressed="usageScope === 'agent'" @click="setUsageScope('agent')">{{ agentsState.currentAgent.value?.name || "当前 Agent" }}</button>
        <button class="segmented-button" type="button" :aria-pressed="usageScope === 'all'" @click="setUsageScope('all')">全部 Agent</button>
      </div>

      <div class="mt-8 flex flex-wrap items-end gap-2">
        <label class="grid min-w-56 gap-2">
          <span class="meta-label">QQ 账号</span>
          <select v-model="selectedAccountId" class="control min-h-11" aria-label="当前 QQ 账号" :disabled="currentAccounts.length === 0">
            <option v-if="currentAccounts.length === 0" value="">还没有 QQ 账号</option>
            <option v-for="account in currentAccounts" :key="account.id" :value="account.id">{{ accountOptionLabel(account) }}</option>
          </select>
        </label>
        <button class="btn btn-primary" type="button" @click="openAccount"><i class="bx bxl-qq" aria-hidden="true"></i>{{ selectedAccount ? qqState === "online" ? "QQ 账号" : "QQ 登录" : "新增 QQ" }}</button>
        <button class="btn" type="button" :disabled="!selectedAccount" @click="openChats"><i class="bx bx-group" aria-hidden="true"></i>联系人</button>
        <button class="btn btn-ghost" type="button" :disabled="!selectedAccount" @click="openCurrentNapCat"><i class="bx bx-link-external" aria-hidden="true"></i>NapCat</button>
        <button class="btn btn-ghost" type="button" @click="diagnosticsOpen = true"><i class="bx bx-pulse" aria-hidden="true"></i>诊断</button>
      </div>

      <OneBotStatusPanel
        class="mt-4"
        :primary-state="primaryState"
        :connected="runtimeConnected"
        :qq-state="qqState"
        :qq="qqIdentity"
        :nickname="qqNickname"
        :connections="runtime.status.value?.onebot.connections ?? 0"
        :connected-at="runtime.status.value?.onebot.connectedAt"
        :last-event-at="runtime.status.value?.onebot.lastEventAt"
        :last-message-event-at="runtime.status.value?.onebot.lastMessageEventAt"
        :refreshing="runtime.loading.value || actionMessage === '刷新中'"
        @refresh="refreshAll"
      />

      <section class="count-mosaic" aria-label="内容统计">
        <article v-for="metric in countMetrics" :key="metric.label" class="count-card" :data-tone="metric.tone">
          <span class="count-card__icon"><i class="bx" :class="metric.icon" aria-hidden="true"></i></span>
          <div class="min-w-0"><span class="meta-label">{{ metric.label }}</span><strong :title="formatExactNumber(metric.value)">{{ formatDashboardMetric(metric.value) }}</strong></div>
        </article>
      </section>

      <TokenUsageDashboard
        :usage="tokenUsage"
        :loading="tokenUsageLoading || actionMessage === '刷新中'"
        :model="tokenUsageModel"
        :behavior="tokenUsageBehavior"
        @filters-change="applyTokenUsageFilters"
      />

      <section class="health-mosaic" aria-label="模型与系统状态">
        <article class="health-card">
          <span class="health-card__icon"><i class="bx bx-chip" aria-hidden="true"></i></span>
          <div class="min-w-0"><span class="meta-label">Provider</span><strong>{{ runtime.status.value?.provider.defaultProviderId ?? "--" }}</strong><small>{{ runtime.status.value?.provider.model ?? "--" }}</small></div>
        </article>
        <article class="health-card">
          <span class="health-card__icon"><i class="bx bx-key" aria-hidden="true"></i></span>
          <div class="min-w-0"><span class="meta-label">Provider 状态</span><strong :class="providerReadiness.tone">{{ providerReadiness.label }}</strong><small>{{ providerReadiness.detail }}</small></div>
        </article>
        <article class="health-card">
          <span class="health-card__icon"><i class="bx bx-user-voice" aria-hidden="true"></i></span>
          <div class="min-w-0"><span class="meta-label">Agent</span><strong>{{ runtime.status.value?.persona.name ?? "--" }}</strong><small>{{ runtime.status.value?.persona.id ?? "--" }}</small></div>
        </article>
        <article class="health-card health-card--wide">
          <span class="health-card__icon text-mute"><i class="bx bx-time-five" aria-hidden="true"></i></span>
          <div class="min-w-0"><span class="meta-label">启动时间</span><strong>{{ formatFullDateTime(runtime.status.value?.startedAt) }}</strong></div>
        </article>
      </section>

      <section v-if="runtime.status.value?.recovery?.required" class="mt-12 border-l-2 border-accent py-4 pl-5">
        <p class="inline-state" data-kind="error">配置需要恢复</p>
        <p class="mt-3 text-sm text-ink">{{ runtime.status.value.recovery.message }}</p>
        <p class="mt-2 break-all font-mono text-[10px] text-mute">{{ runtime.status.value.recovery.backupPath }}</p>
      </section>
    </div>

    <OneBotLoginDialog
      :open="qqLogin.open.value"
      :account-id="loginAccount?.id ?? ''"
      :account-label="loginAccount?.label ?? ''"
      :busy="qqLogin.busy.value"
      :checking="qqLogin.checking.value"
      :snapshot="qqLogin.snapshot.value"
      :error="qqLogin.error.value"
      :confirming-logout="qqLogin.confirmingLogout.value"
      @close="closeQqLogin"
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
.count-mosaic { display: grid; margin-top: 32px; border-block: 1px solid rgb(var(--color-line)); }
.count-card, .health-card { min-width: 0; background: transparent; }
.count-card { display: flex; min-height: 112px; align-items: center; gap: 18px; border-bottom: 1px solid rgb(var(--color-line)); padding: 20px 0; }
.count-card:last-child { border-bottom: 0; }
.count-card__icon, .health-card__icon { display: grid; flex: none; place-items: center; background: transparent; font-size: 28px; }
.count-card__icon { width: 36px; height: 36px; color: rgb(var(--color-mute)); }
.count-card strong { display: block; margin-top: 7px; color: rgb(var(--color-display)); font-family: "Doto Variable", "Space Mono", monospace; font-size: 30px; font-weight: 700; line-height: 1; letter-spacing: -.035em; }
.health-mosaic { display: grid; margin-top: 48px; border-top: 1px solid rgb(var(--color-line)); }
.health-card { display: flex; min-height: 104px; align-items: center; gap: 16px; border-bottom: 1px solid rgb(var(--color-line)); padding: 20px 0; }
.health-card__icon { width: 32px; height: 32px; color: rgb(var(--color-mute)); }
.health-card strong { display: block; overflow: hidden; margin-top: 7px; color: rgb(var(--color-display)); font-size: 14px; font-weight: 500; text-overflow: ellipsis; white-space: nowrap; }
.health-card small { display: block; overflow: hidden; margin-top: 4px; color: rgb(var(--color-mute)); font-family: "Space Mono", monospace; font-size: 9px; text-overflow: ellipsis; white-space: nowrap; }
@media (min-width: 640px) {
  .count-mosaic { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .count-card { border-bottom: 0; padding: 20px 18px; }
  .count-card:first-child { padding-left: 0; }
  .count-card + .count-card { border-left: 1px solid rgb(var(--color-line)); }
  .health-mosaic { grid-template-columns: repeat(2, minmax(0,1fr)); }
  .health-card { padding: 20px; }
  .health-card:nth-child(odd) { padding-left: 0; }
  .health-card:nth-child(even) { border-left: 1px solid rgb(var(--color-line)); }
}
@media (min-width: 1100px) {
  .health-mosaic { grid-template-columns: repeat(5, minmax(0,1fr)); }
  .health-card, .health-card:nth-child(odd) { grid-column: span 1; padding: 20px; }
  .health-card:first-child { padding-left: 0; }
  .health-card + .health-card { border-left: 1px solid rgb(var(--color-line)); }
  .health-card--wide { grid-column: span 2; }
}
</style>
