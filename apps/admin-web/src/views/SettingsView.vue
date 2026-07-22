<script setup lang="ts">
import { computed, defineAsyncComponent, nextTick, onBeforeUnmount, onMounted, shallowRef, useTemplateRef, watch } from "vue";
import { onBeforeRouteLeave, useRoute, useRouter } from "vue-router";
import { useConfigWorkspace, sectionKeys } from "../composables/useConfigWorkspace";
import { useModelCatalog } from "../composables/useModelCatalog";
import { apiRequest } from "../composables/useAdminApi";
import type { ConfigSectionKey, SettingsSectionKey } from "../types";
import { focusConfigField } from "../utils/configFieldFocus";
import PageHeader from "../components/ui/PageHeader.vue";
import SettingsNavigation from "../components/settings/SettingsNavigation.vue";
import DialogOverlay from "../components/ui/DialogOverlay.vue";
import { activeAgentId, activeAgentIdState, setActiveAgentId } from "../composables/agentScope";
import { settingsForScope } from "../components/settings/settingsCatalog";

const props = withDefaults(defineProps<{ scope?: "agent" | "system" }>(), { scope: "agent" });
const PersonaSettingsForm = defineAsyncComponent(() => import("../components/settings/PersonaSettingsForm.vue"));
const ProviderSettings = defineAsyncComponent(() => import("../components/settings/ProviderSettings.vue"));
const BroadcastStormSettingsForm = defineAsyncComponent(() => import("../components/settings/BroadcastStormSettingsForm.vue"));
const NormalReplySettingsForm = defineAsyncComponent(() => import("../components/settings/NormalReplySettingsForm.vue"));
const BotSettingsForm = defineAsyncComponent(() => import("../components/settings/BotSettingsForm.vue"));
const ToneSettingsForm = defineAsyncComponent(() => import("../components/settings/ToneSettingsForm.vue"));
const MemorySettingsForm = defineAsyncComponent(() => import("../components/settings/MemorySettingsForm.vue"));
const OrchestratorSettingsForm = defineAsyncComponent(() => import("../components/settings/OrchestratorSettingsForm.vue"));
const ToolsSettingsForm = defineAsyncComponent(() => import("../components/settings/ToolsSettingsForm.vue"));
const BashSettingsForm = defineAsyncComponent(() => import("../components/settings/BashSettingsForm.vue"));
const OneBotSettingsForm = defineAsyncComponent(() => import("../components/settings/OneBotSettingsForm.vue"));
const MonitoringSettingsForm = defineAsyncComponent(() => import("../components/settings/MonitoringSettingsForm.vue"));
const AdminPasswordForm = defineAsyncComponent(() => import("../components/settings/AdminPasswordForm.vue"));

const route = useRoute();
const router = useRouter();
const workspace = useConfigWorkspace(props.scope);
const catalog = useModelCatalog();
const loadError = shallowRef("");
const switchError = shallowRef("");
const pendingSwitchAgentId = shallowRef("");
const logoutConfirmOpen = shallowRef(false);
const loggingOut = shallowRef(false);
const logoutError = shallowRef("");
const settingsPanel = useTemplateRef<HTMLElement>("settingsPanel");
const monitoringForm = useTemplateRef<{ flush(): Promise<boolean> }>("monitoringForm");
const sections = computed(() => settingsForScope(props.scope));
const visibleSections = computed(() => new Set(sections.value.map((section) => section.id)));
const configSections = new Set<ConfigSectionKey>(sectionKeys);
const current = computed<SettingsSectionKey>(() => {
  const fallback = props.scope === "agent" ? "persona" : "providers";
  const value = String(route.params.section ?? fallback) as SettingsSectionKey;
  return visibleSections.value.has(value) ? value : fallback;
});
const currentState = computed(() => {
  const section = isConfigSection(current.value) ? current.value : "persona";
  const candidates = section === "persona"
    ? [workspace.state.bot, workspace.state.persona]
    : section === "bot"
    ? [workspace.state.bot, workspace.state.onebot]
    : section === "tools"
      ? [workspace.state.tools, workspace.state.bash, workspace.state.bot]
      : [workspace.state[section]];
  return candidates.find((entry) => entry.kind === "error" || entry.kind === "conflict")
    ?? candidates.find((entry) => entry.kind === "restart")
    ?? candidates[0]!;
});
const visibleState = computed(() => ["error", "conflict", "restart"].includes(currentState.value.kind));

onMounted(async () => {
  const [loaded] = await Promise.all([loadConfig(), catalog.load()]);
  if (loaded && props.scope === "agent") stableAgentId = workspace.agentId();
});
onBeforeUnmount(() => workspace.cancel());

let agentSwitchSequence = 0;
let restoringAgent = false;
let stableAgentId = workspace.agentId();
watch(activeAgentIdState, (next) => {
  if (props.scope !== "agent" || restoringAgent || next === workspace.agentId()) return;
  const sequence = ++agentSwitchSequence;
  void switchAgent(next, sequence);
}, { flush: "sync" });

watch(currentState, async (entry) => {
  if (entry.kind !== "error" || !entry.field || !settingsPanel.value) return;
  await nextTick();
  focusConfigField(settingsPanel.value, entry.field);
});

onBeforeRouteLeave(async () => {
  const [configSynced, monitoringSynced] = await Promise.all([
    workspace.flush(),
    monitoringForm.value?.flush() ?? true
  ]);
  return configSynced && monitoringSynced;
});

async function loadConfig(preserveDirty = false, agentId?: string) {
  try {
    await workspace.load({ preserveDirty, agentId });
    loadError.value = "";
    return true;
  } catch (error) {
    loadError.value = error instanceof Error ? error.message : "配置读取失败";
    return false;
  }
}

async function switchAgent(nextAgentId: string, sequence: number) {
  const previousAgentId = stableAgentId;
  const saved = await workspace.flush();
  if (sequence !== agentSwitchSequence) return;
  if (!saved) {
    pendingSwitchAgentId.value = nextAgentId;
    restoreActiveAgent(previousAgentId);
    switchError.value = "设置保存失败，请处理后重试，或放弃更改后切换。";
    return;
  }
  const loaded = await loadConfig(false, nextAgentId);
  if (sequence !== agentSwitchSequence) return;
  if (loaded) {
    stableAgentId = nextAgentId;
    pendingSwitchAgentId.value = "";
    switchError.value = "";
    return;
  }
  restoreActiveAgent(previousAgentId);
  await loadConfig(false, previousAgentId);
  switchError.value = "Agent 配置读取失败，已返回原 Agent。";
}

async function discardAndSwitch() {
  const nextAgentId = pendingSwitchAgentId.value;
  if (!nextAgentId) return;
  const previousAgentId = stableAgentId;
  const sequence = ++agentSwitchSequence;
  pendingSwitchAgentId.value = "";
  switchError.value = "";
  restoreActiveAgent(nextAgentId);
  const loaded = await loadConfig(false, nextAgentId);
  if (sequence !== agentSwitchSequence) return;
  if (loaded) {
    stableAgentId = nextAgentId;
    return;
  }
  restoreActiveAgent(previousAgentId);
  await loadConfig(false, previousAgentId);
  switchError.value = "Agent 配置读取失败，已返回原 Agent。";
}

function restoreActiveAgent(agentId: string) {
  restoringAgent = true;
  try {
    setActiveAgentId(agentId);
  } finally {
    restoringAgent = false;
  }
}

function selectSection(section: SettingsSectionKey) {
  void router.push(`/${props.scope === "agent" ? "agent-settings" : "settings"}/${section}`);
}

function isConfigSection(section: SettingsSectionKey): section is ConfigSectionKey {
  return configSections.has(section as ConfigSectionKey);
}

function currentConfigSections() {
  if (!isConfigSection(current.value)) return [];
  if (current.value === "persona") return ["bot"] as const;
  if (current.value === "bot") return ["bot", "onebot"] as const;
  if (current.value === "tools") return ["tools", "bash", "bot"] as const;
  return [current.value] as const;
}

async function commitCurrentSection() {
  await nextTick();
  await Promise.all(currentConfigSections().map((section) => workspace.commit(section)));
}

function handleControlChange(event: Event) {
  const target = event.target;
  if (target instanceof HTMLSelectElement || (target instanceof HTMLInputElement && target.type === "checkbox")) {
    void commitCurrentSection();
  }
}

function handleSettingsClick(event: MouseEvent) {
  if ((event.target as HTMLElement | null)?.closest("[data-settings-confirm],[data-settings-commit]")) {
    void commitCurrentSection();
  }
}

function handleSettingsKeydown(event: KeyboardEvent) {
  if (event.key === "Enter" && event.target instanceof HTMLElement && event.target.matches("[data-settings-confirm-input]")) {
    void commitCurrentSection();
  }
}

async function logout() {
  loggingOut.value = true;
  logoutError.value = "";
  try {
    await apiRequest<void>("/api/auth/logout", { method: "POST" });
    window.location.reload();
  } catch (error) {
    logoutError.value = error instanceof Error ? error.message : "退出失败";
  } finally {
    loggingOut.value = false;
  }
}
</script>

<template>
  <div class="page-shell">
    <div class="page-frame">
      <PageHeader :title="props.scope === 'agent' ? 'Agent 设置' : '系统设置'">
        <template #actions>
          <button class="btn" type="button" :disabled="workspace.loading.value" @click="loadConfig(true)">刷新</button>
          <button v-if="props.scope === 'system'" class="btn btn-ghost" type="button" @click="logoutConfirmOpen = true"><i class="bx bx-log-out" aria-hidden="true"></i>退出登录</button>
        </template>
      </PageHeader>

      <div v-if="switchError" class="mt-4 flex flex-wrap items-center gap-3" role="status" aria-live="polite">
        <span class="inline-state" data-kind="error">{{ switchError }}</span>
        <button v-if="pendingSwitchAgentId" class="btn btn-ghost" type="button" @click="discardAndSwitch">放弃更改并切换</button>
      </div>

      <div v-if="workspace.loading.value && !workspace.envelope.value" class="empty-state"><div><strong>加载中</strong></div></div>
      <div v-else-if="loadError" class="empty-state"><div><strong class="!text-accent">{{ loadError }}</strong><button class="btn mt-4" type="button" @click="loadConfig()">重试</button></div></div>
      <div v-else class="mt-2 grid min-w-0 gap-8 lg:grid-cols-[200px_minmax(0,1fr)] xl:grid-cols-[224px_minmax(0,920px)] xl:gap-12">
        <SettingsNavigation :current="current" :sections="sections" @select="selectSection" />
        <section
          ref="settingsPanel"
          class="min-w-0"
          @change="handleControlChange"
          @click="handleSettingsClick"
          @keydown="handleSettingsKeydown"
        >
          <div v-if="current === 'persona'" class="grid gap-12">
            <PersonaSettingsForm v-model="workspace.drafts.bot" :agent-id="activeAgentId()" />
          </div>
          <ProviderSettings
            v-else-if="current === 'providers'"
            v-model="workspace.drafts.providers"
            :models="catalog.models.value"
            :field-states="workspace.envelope.value?.fieldStates"
            @commit="workspace.commit('providers')"
          />
          <BroadcastStormSettingsForm
            v-else-if="current === 'broadcastStorm'"
            v-model="workspace.drafts.broadcastStorm"
          />
          <NormalReplySettingsForm
            v-else-if="current === 'normalReply'"
            v-model="workspace.drafts.normalReply"
          />
          <BotSettingsForm
            v-else-if="current === 'bot'"
            v-model="workspace.drafts.bot"
            v-model:reply="workspace.drafts.onebot"
          />
          <ToneSettingsForm
            v-else-if="current === 'tone'"
            v-model="workspace.drafts.tone"
            :models="catalog.models.value"
            :providers="workspace.drafts.providers.items"
            :default-provider-id="workspace.drafts.providers.defaultProviderId"
            :main-max-retries="workspace.drafts.normalReply.maxRetries"
          />
          <MemorySettingsForm v-else-if="current === 'memory'" v-model="workspace.drafts.memory" :models="catalog.models.value" />
          <OrchestratorSettingsForm
            v-else-if="current === 'orchestrator'"
            v-model="workspace.drafts.orchestrator"
            v-model:group-enabled="workspace.drafts.onebot.autoReplyUserGroup"
            :models="catalog.models.value"
          />
          <ToolsSettingsForm
            v-else-if="current === 'tools'"
            v-model="workspace.drafts.tools"
            :models="catalog.models.value"
            :field-states="workspace.envelope.value?.fieldStates"
            v-model:bash="workspace.drafts.bash"
            v-model:poke-on-no-reply="workspace.drafts.bot.pokeOnNoReply"
            @commit="commitCurrentSection"
          />
          <BashSettingsForm v-else-if="current === 'bash'" v-model="workspace.drafts.bash" />
          <AdminPasswordForm v-else-if="current === 'security'" />
          <div v-else class="grid gap-12">
            <div>
              <h2 class="section-title">连接与通知</h2>
              <p class="mt-2 text-sm leading-6 text-mute">管理 Bark 通知和 OneBot 反向连接。</p>
            </div>
            <MonitoringSettingsForm ref="monitoringForm" nested />
            <OneBotSettingsForm
              v-model="workspace.drafts.onebot"
              :field-states="workspace.envelope.value?.fieldStates"
              nested
            />
          </div>

          <div v-if="visibleState" class="mt-6 flex flex-wrap items-center gap-3" role="status" aria-live="polite">
            <span class="inline-state" :data-kind="currentState.kind === 'restart' ? 'warning' : 'error'">{{ currentState.message }}</span>
            <button v-if="currentState.kind === 'error' || currentState.kind === 'conflict'" class="btn btn-ghost" type="button" @click="commitCurrentSection">重试</button>
          </div>
        </section>
      </div>
    </div>
  </div>

  <DialogOverlay :open="logoutConfirmOpen" labelledby="settings-logout-title" @close="logoutConfirmOpen = false">
    <section class="w-full max-w-md rounded border border-visible bg-panel p-6">
      <h2 id="settings-logout-title" class="text-xl font-medium text-display">退出管理台？</h2>
      <p class="mt-3 text-sm leading-6 text-mute">下次访问需要重新登录。</p>
      <p v-if="logoutError" class="mt-4 inline-state" data-kind="error">{{ logoutError }}</p>
      <div class="mt-8 flex flex-wrap justify-end gap-2">
        <button class="btn btn-ghost" type="button" :disabled="loggingOut" @click="logoutConfirmOpen = false">取消</button>
        <button class="btn btn-danger" type="button" :disabled="loggingOut" @click="logout"><i class="bx bx-log-out" aria-hidden="true"></i>{{ loggingOut ? "正在退出" : "退出登录" }}</button>
      </div>
    </section>
  </DialogOverlay>
</template>
