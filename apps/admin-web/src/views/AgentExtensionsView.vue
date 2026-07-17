<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, shallowRef, watch } from "vue";
import ConfirmActionDialog from "../components/extensions/ConfirmActionDialog.vue";
import McpApprovalQueue from "../components/extensions/McpApprovalQueue.vue";
import McpDetailDialog from "../components/extensions/McpDetailDialog.vue";
import McpOAuthDialog from "../components/extensions/McpOAuthDialog.vue";
import McpServerDialog from "../components/extensions/McpServerDialog.vue";
import McpServerList from "../components/extensions/McpServerList.vue";
import SkillCopyDialog from "../components/extensions/SkillCopyDialog.vue";
import SkillInstallDialog from "../components/extensions/SkillInstallDialog.vue";
import SkillList from "../components/extensions/SkillList.vue";
import SkillReviewDialog from "../components/extensions/SkillReviewDialog.vue";
import PageHeader from "../components/ui/PageHeader.vue";
import { useAgentExtensions } from "../composables/useAgentExtensions";
import { useAgents } from "../composables/useAgents";
import type {
  AgentMcpHttpServer,
  AgentMcpServer,
  AgentSkillRecord,
  McpCatalogSnapshot,
  McpInstallPreview,
  SkillCopyPreview
} from "../types/agentExtensions";

const agents = useAgents();
const extensions = useAgentExtensions();
const installOpen = shallowRef(false);
const reviewSkill = shallowRef<AgentSkillRecord | null>(null);
const copySkill = shallowRef<AgentSkillRecord | null>(null);
const copyPreview = shallowRef<SkillCopyPreview | null>(null);
const mcpDialogOpen = shallowRef(false);
const editingMcp = shallowRef<AgentMcpServer | null>(null);
const mcpPreview = shallowRef<McpInstallPreview | null>(null);
const detailMcp = shallowRef<AgentMcpServer | null>(null);
const mcpCatalog = shallowRef<McpCatalogSnapshot | null>(null);
const catalogLoading = shallowRef(false);
const catalogError = shallowRef("");
const oauthMcp = shallowRef<AgentMcpHttpServer | null>(null);
const oauthPopupError = shallowRef("");
const oauthAuthorizationOrigin = shallowRef("");
const confirm = shallowRef<null | { kind: "skill" | "mcp"; id: string; name: string }>(null);
const agentId = computed(() => agents.currentAgent.value?.id ?? agents.currentAgentId.value);
const agentName = computed(() => agents.currentAgent.value?.name ?? agentId.value);
const overview = computed(() => extensions.overview.value?.agentId === agentId.value
  ? extensions.overview.value
  : null);
const enabledSkills = computed(() => overview.value?.skills.filter((skill) => skill.enabled).length ?? 0);
const readyMcp = computed(() => extensions.runtime.value.servers.filter((server) => (
  server.status === "ready" && server.toolCatalogStatus === "ready"
)).length);
const MAX_OAUTH_RETURN_REFRESHES = 6;
const OAUTH_RETURN_REFRESH_DELAY_MS = 1_000;
let oauthReturnWatching = false;
let oauthReturnRefreshes = 0;
let oauthReturnRefreshInFlight = false;
let oauthReturnTimer: number | undefined;

onMounted(async () => {
  await agents.load().catch(() => undefined);
  await extensions.load(agentId.value).catch(() => undefined);
});

watch(agentId, (next, previous) => {
  if (next !== previous) {
    closeAgentScopedState();
    void extensions.load(next).catch(() => undefined);
  }
});

onBeforeUnmount(stopOAuthReturnWatch);

function openInstall() {
  extensions.clearFeedback();
  installOpen.value = true;
}

function openReview(skill: AgentSkillRecord) {
  extensions.clearFeedback();
  reviewSkill.value = skill;
}

async function install(input: { archive: File; replace: boolean }) {
  try {
    await extensions.installSkill(agentId.value, input.archive, input.replace);
    installOpen.value = false;
  } catch {
    // The dialog keeps the actionable API error visible.
  }
}

async function approveSkill(skill: AgentSkillRecord) {
  try {
    await extensions.reviewSkill(agentId.value, skill.id);
    reviewSkill.value = null;
  } catch {
    // The dialog keeps the actionable API error visible.
  }
}

async function toggleSkill(skill: AgentSkillRecord) {
  await extensions.setSkillEnabled(agentId.value, skill.id, !skill.enabled).catch(() => undefined);
}

function openCopy(skill: AgentSkillRecord) {
  extensions.clearFeedback();
  copyPreview.value = null;
  copySkill.value = skill;
}

async function previewCopy(input: { targetAgentId: string; mcpServerIds: string[] }) {
  if (!copySkill.value) return;
  try {
    copyPreview.value = await extensions.previewSkillCopy({
      sourceAgentId: agentId.value,
      targetAgentId: input.targetAgentId,
      skillId: copySkill.value.id,
      mcpServerIds: input.mcpServerIds
    });
  } catch {
    copyPreview.value = null;
  }
}

async function applyCopy(input: {
  targetAgentId: string;
  mcpServerIds: string[];
  conflictStrategy: "skip" | "replace" | "rename";
  renameTo?: string;
}) {
  if (!copySkill.value || !copyPreview.value) return;
  try {
    await extensions.applySkillCopy({
      sourceAgentId: agentId.value,
      targetAgentId: input.targetAgentId,
      skillId: copySkill.value.id,
      mcpServerIds: input.mcpServerIds,
      previewRevision: copyPreview.value.previewRevision,
      conflictStrategy: input.conflictStrategy,
      ...(input.renameTo ? { renameTo: input.renameTo } : {})
    });
    copySkill.value = null;
    copyPreview.value = null;
  } catch {
    // The dialog keeps the actionable API error visible.
  }
}

function openMcp(server: AgentMcpServer | null = null) {
  extensions.clearFeedback();
  editingMcp.value = server;
  mcpPreview.value = null;
  mcpDialogOpen.value = true;
}

async function previewMcp(server: AgentMcpServer) {
  try {
    mcpPreview.value = await extensions.previewMcpServer(agentId.value, server);
  } catch {
    mcpPreview.value = null;
  }
}

async function saveMcp() {
  if (!mcpPreview.value) return;
  try {
    await extensions.putMcpServer(agentId.value, mcpPreview.value, Boolean(editingMcp.value));
    mcpDialogOpen.value = false;
    mcpPreview.value = null;
    editingMcp.value = null;
  } catch {
    // The dialog keeps the actionable API error visible.
  }
}

async function toggleMcp(server: AgentMcpServer) {
  await extensions.setMcpServerEnabled(agentId.value, server.id, !server.enabled).catch(() => undefined);
}

function openOAuth(server: AgentMcpServer) {
  if (server.transport === "streamable_http" && server.auth.kind === "oauth") {
    extensions.clearFeedback();
    stopOAuthReturnWatch();
    oauthPopupError.value = "";
    oauthAuthorizationOrigin.value = "";
    oauthMcp.value = server;
  }
}

async function openDetail(server: AgentMcpServer) {
  extensions.clearFeedback();
  detailMcp.value = server;
  mcpCatalog.value = null;
  catalogError.value = "";
  if (server.enabled) await loadCatalog();
}

async function loadCatalog() {
  if (!detailMcp.value) return;
  const expectedAgentId = agentId.value;
  const expectedServerId = detailMcp.value.id;
  catalogLoading.value = true;
  catalogError.value = "";
  try {
    const catalog = await extensions.loadMcpCatalog(expectedAgentId, expectedServerId);
    if (agentId.value === expectedAgentId && detailMcp.value?.id === expectedServerId) {
      mcpCatalog.value = catalog;
    }
  } catch (cause) {
    if (agentId.value === expectedAgentId && detailMcp.value?.id === expectedServerId) {
      catalogError.value = cause instanceof Error ? cause.message : "目录读取失败";
    }
  } finally {
    if (agentId.value === expectedAgentId && detailMcp.value?.id === expectedServerId) {
      catalogLoading.value = false;
    }
  }
}

async function beginOAuth(input: {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  clientId: string;
  scopes: string[];
}) {
  if (!oauthMcp.value) return;
  const expectedAgentId = agentId.value;
  const expectedServerId = oauthMcp.value.id;
  const popup = window.open("about:blank", "sunabot-mcp-oauth", "popup");
  if (!popup) {
    oauthPopupError.value = "浏览器拦截了授权窗口，请允许弹出窗口后重试。";
    return;
  }
  popup.opener = null;
  oauthPopupError.value = "";
  try {
    const result = await extensions.beginOAuth(expectedAgentId, expectedServerId, input);
    if (agentId.value !== expectedAgentId || oauthMcp.value?.id !== expectedServerId) {
      popup.close();
      return;
    }
    oauthAuthorizationOrigin.value = result.authorizationOrigin;
    popup.location.replace(result.authorizationUrl);
    startOAuthReturnWatch();
  } catch {
    popup.close();
  }
}

async function refreshOAuth() {
  if (!oauthMcp.value) return;
  try {
    await extensions.refreshOAuth(agentId.value, oauthMcp.value.id);
    closeOAuth();
  } catch {
    // The dialog keeps the actionable API error visible.
  }
}

async function revokeOAuth() {
  if (!oauthMcp.value) return;
  try {
    await extensions.revokeOAuth(agentId.value, oauthMcp.value.id);
    closeOAuth();
  } catch {
    // The dialog keeps the actionable API error visible.
  }
}

function closeOAuth() {
  stopOAuthReturnWatch();
  oauthMcp.value = null;
  oauthPopupError.value = "";
  oauthAuthorizationOrigin.value = "";
}

function closeAgentScopedState() {
  closeOAuth();
  installOpen.value = false;
  reviewSkill.value = null;
  copySkill.value = null;
  copyPreview.value = null;
  mcpDialogOpen.value = false;
  editingMcp.value = null;
  mcpPreview.value = null;
  detailMcp.value = null;
  mcpCatalog.value = null;
  catalogLoading.value = false;
  catalogError.value = "";
  confirm.value = null;
}

function startOAuthReturnWatch() {
  stopOAuthReturnWatch();
  oauthReturnWatching = true;
  window.addEventListener("focus", handleOAuthReturnSignal);
  document.addEventListener("visibilitychange", handleOAuthReturnSignal);
}

function stopOAuthReturnWatch() {
  oauthReturnWatching = false;
  oauthReturnRefreshes = 0;
  if (oauthReturnTimer) window.clearTimeout(oauthReturnTimer);
  oauthReturnTimer = undefined;
  window.removeEventListener("focus", handleOAuthReturnSignal);
  document.removeEventListener("visibilitychange", handleOAuthReturnSignal);
}

function handleOAuthReturnSignal() {
  if (document.visibilityState !== "visible") return;
  void refreshOAuthStateOnReturn();
}

async function refreshOAuthStateOnReturn() {
  if (!oauthReturnWatching || oauthReturnRefreshInFlight || !oauthMcp.value) return;
  if (oauthReturnRefreshes >= MAX_OAUTH_RETURN_REFRESHES) {
    stopOAuthReturnWatch();
    return;
  }
  const expectedAgentId = agentId.value;
  const expectedServerId = oauthMcp.value.id;
  oauthReturnRefreshInFlight = true;
  oauthReturnRefreshes += 1;
  try {
    await extensions.load(expectedAgentId);
    if (!oauthReturnWatching || agentId.value !== expectedAgentId || oauthMcp.value?.id !== expectedServerId) return;
    const refreshed = extensions.overview.value?.mcp.servers.find((server) => server.id === expectedServerId);
    if (refreshed?.transport === "streamable_http" && refreshed.auth.kind === "oauth") {
      oauthMcp.value = refreshed;
      if (/^mcpcred_/.test(refreshed.auth.credentialRef)) stopOAuthReturnWatch();
    }
  } catch {
    // The existing inline error remains visible while bounded refresh continues.
  } finally {
    oauthReturnRefreshInFlight = false;
    if (!oauthReturnWatching) return;
    if (oauthReturnRefreshes >= MAX_OAUTH_RETURN_REFRESHES) {
      stopOAuthReturnWatch();
      return;
    }
    oauthReturnTimer = window.setTimeout(() => {
      oauthReturnTimer = undefined;
      void refreshOAuthStateOnReturn();
    }, OAUTH_RETURN_REFRESH_DELAY_MS);
  }
}

function openConfirm(kind: "skill" | "mcp", item: { id: string; name: string }) {
  extensions.clearFeedback();
  confirm.value = { kind, id: item.id, name: item.name };
}

async function runConfirmedAction() {
  const action = confirm.value;
  if (!action) return;
  try {
    if (action.kind === "skill") await extensions.removeSkill(agentId.value, action.id);
    else await extensions.removeMcpServer(agentId.value, action.id);
    confirm.value = null;
  } catch {
    // The page feedback remains visible.
  }
}

async function approveTicket(ticketId: string) {
  await extensions.approveMcpTool(agentId.value, ticketId).catch(() => undefined);
}
</script>

<template>
  <div class="page-shell">
    <div class="page-frame">
      <PageHeader title="扩展" description="管理当前 Agent 的 Skill、MCP 服务与一次性批准。">
        <template #actions>
          <span v-if="extensions.message.value" class="inline-state" data-kind="success" role="status" aria-live="polite">{{ extensions.message.value }}</span>
          <button class="icon-btn" type="button" :disabled="extensions.loading.value" aria-label="刷新扩展" @click="extensions.load(agentId)"><i class="bx bx-refresh" :class="extensions.loading.value ? 'bx-spin' : ''" aria-hidden="true"></i></button>
        </template>
      </PageHeader>

      <section class="grid border-y border-visible sm:grid-cols-4" aria-label="扩展概览">
        <div class="py-5 sm:border-r sm:border-line"><span class="meta-label">当前 Agent</span><strong class="mt-3 block truncate text-lg font-medium text-display">{{ agents.currentAgent.value?.name || agentId }}</strong></div>
        <div class="border-t border-line py-5 sm:border-r sm:border-t-0 sm:border-line sm:px-5"><span class="meta-label">Skill</span><strong class="mt-3 block font-display text-3xl text-display">{{ overview?.skills.length ?? 0 }}</strong><small class="font-mono text-[10px] text-mute">{{ enabledSkills }} 已启用</small></div>
        <div class="border-t border-line py-5 sm:border-r sm:border-t-0 sm:border-line sm:px-5"><span class="meta-label">MCP</span><strong class="mt-3 block font-display text-3xl text-display">{{ overview?.mcp.servers.length ?? 0 }}</strong><small class="font-mono text-[10px] text-mute">{{ readyMcp }} 就绪</small></div>
        <div class="border-t border-line py-5 sm:border-t-0 sm:pl-5"><span class="meta-label">批准队列</span><strong class="mt-3 block font-display text-3xl" :class="extensions.approvals.value.length ? 'text-warning' : 'text-display'">{{ extensions.approvals.value.length }}</strong><small class="font-mono text-[10px] text-mute">一次性请求</small></div>
      </section>

      <p v-if="extensions.error.value" class="mt-5 border-l-2 border-accent pl-4 text-sm text-accent" role="alert">{{ extensions.error.value }}</p>
      <p v-if="extensions.loading.value && !overview" class="mt-8 font-mono text-xs uppercase text-mute" role="status">[LOADING] 扩展</p>

      <div v-if="overview" class="mt-12 grid gap-16 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] xl:gap-12">
        <SkillList
          :skills="overview.skills"
          :busy="extensions.busy.value"
          @review="openReview"
          @toggle="toggleSkill"
          @copy="openCopy"
          @remove="openConfirm('skill', $event)"
        >
          <template #actions><button class="btn btn-primary" type="button" @click="openInstall"><i class="bx bx-plus" aria-hidden="true"></i>安装 ZIP</button></template>
        </SkillList>
        <McpServerList
          :servers="overview.mcp.servers"
          :secrets="overview.mcp.secrets"
          :statuses="extensions.runtime.value.servers"
          :busy="extensions.busy.value"
          @edit="openMcp"
          @detail="openDetail"
          @toggle="toggleMcp"
          @oauth="openOAuth"
          @remove="openConfirm('mcp', $event)"
        >
          <template #actions><button class="btn btn-primary" type="button" @click="openMcp()"><i class="bx bx-plus" aria-hidden="true"></i>添加服务</button></template>
        </McpServerList>
      </div>

      <McpApprovalQueue class="mt-16" :approvals="extensions.approvals.value" :busy="extensions.busy.value" @approve="approveTicket($event.id)" />
    </div>
  </div>

  <SkillInstallDialog :open="installOpen" :busy="extensions.busy.value" :error="extensions.error.value" @close="installOpen = false" @submit="install" />
  <SkillReviewDialog :skill="reviewSkill" :busy="extensions.busy.value" :error="extensions.error.value" @close="reviewSkill = null" @approve="approveSkill" />
  <SkillCopyDialog :skill="copySkill" :source-agent-id="agentId" :agents="agents.agents.value" :preview="copyPreview" :busy="extensions.busy.value" :error="extensions.error.value" @close="copySkill = null; copyPreview = null" @preview="previewCopy" @apply="applyCopy" />
  <McpServerDialog :open="mcpDialogOpen" :server="editingMcp" :preview="mcpPreview" :busy="extensions.busy.value" :error="extensions.error.value" @close="mcpDialogOpen = false; mcpPreview = null" @preview="previewMcp" @save="saveMcp" />
  <McpDetailDialog :server="detailMcp" :status="extensions.runtime.value.servers.find((item) => item.serverId === detailMcp?.id)" :catalog="mcpCatalog" :loading="catalogLoading" :error="catalogError" @close="detailMcp = null" @reload="loadCatalog" />
  <McpOAuthDialog :server="oauthMcp" :agent-id="agentId" :agent-name="agentName" :authorization-origin="oauthAuthorizationOrigin" :busy="extensions.busy.value" :error="oauthPopupError || extensions.error.value" @close="closeOAuth" @begin="beginOAuth" @refresh="refreshOAuth" @revoke="revokeOAuth" />
  <ConfirmActionDialog
    :open="Boolean(confirm)"
    :title="confirm?.kind === 'skill' ? '卸载 Skill？' : '删除 MCP 服务？'"
    :message="`${confirm?.name ?? ''} 将从当前 Agent 移除。`"
    :action="confirm?.kind === 'skill' ? '卸载' : '删除'"
    :busy="extensions.busy.value"
    danger
    @close="confirm = null"
    @confirm="runConfirmedAction"
  />
</template>
