<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, shallowRef, useTemplateRef, watch } from "vue";
import { onBeforeRouteLeave, useRoute, useRouter } from "vue-router";
import { useConfigWorkspace, sectionKeys } from "../composables/useConfigWorkspace";
import { useModelCatalog } from "../composables/useModelCatalog";
import { apiRequest } from "../composables/useAdminApi";
import type { ConfigSectionKey, SettingsSectionKey } from "../types";
import { focusConfigField } from "../utils/configFieldFocus";
import PageHeader from "../components/ui/PageHeader.vue";
import SettingsNavigation from "../components/settings/SettingsNavigation.vue";
import PersonaSettingsForm from "../components/settings/PersonaSettingsForm.vue";
import ProviderSettings from "../components/settings/ProviderSettings.vue";
import BroadcastStormSettingsForm from "../components/settings/BroadcastStormSettingsForm.vue";
import NormalReplySettingsForm from "../components/settings/NormalReplySettingsForm.vue";
import BotSettingsForm from "../components/settings/BotSettingsForm.vue";
import ToneSettingsForm from "../components/settings/ToneSettingsForm.vue";
import MemorySettingsForm from "../components/settings/MemorySettingsForm.vue";
import OrchestratorSettingsForm from "../components/settings/OrchestratorSettingsForm.vue";
import ToolsSettingsForm from "../components/settings/ToolsSettingsForm.vue";
import BashSettingsForm from "../components/settings/BashSettingsForm.vue";
import OneBotSettingsForm from "../components/settings/OneBotSettingsForm.vue";
import MonitoringSettingsForm from "../components/settings/MonitoringSettingsForm.vue";
import DialogOverlay from "../components/ui/DialogOverlay.vue";
import AdminPasswordForm from "../components/settings/AdminPasswordForm.vue";
import { activeAgentId, activeAgentIdState } from "../composables/agentScope";

const props = withDefaults(defineProps<{ scope?: "agent" | "system" }>(), { scope: "agent" });

const route = useRoute();
const router = useRouter();
const workspace = useConfigWorkspace(props.scope);
const catalog = useModelCatalog();
const loadError = shallowRef("");
const logoutConfirmOpen = shallowRef(false);
const loggingOut = shallowRef(false);
const logoutError = shallowRef("");
const settingsPanel = useTemplateRef<HTMLElement>("settingsPanel");
const monitoringForm = useTemplateRef<InstanceType<typeof MonitoringSettingsForm>>("monitoringForm");
const allSections: Array<{ id: SettingsSectionKey; label: string; group: string; icon: string; scope: "agent" | "system" }> = [
  { id: "persona", label: "Agent 身份", group: "Agent", icon: "bx-user-voice", scope: "agent" },
  { id: "bot", label: "回复行为", group: "Agent", icon: "bx-bot", scope: "agent" },
  { id: "tone", label: "语气处理", group: "Agent", icon: "bx-conversation", scope: "agent" },
  { id: "memory", label: "记忆处理", group: "记忆与编排", icon: "bx-brain", scope: "agent" },
  { id: "orchestrator", label: "群聊编排", group: "记忆与编排", icon: "bx-git-branch", scope: "agent" },
  { id: "tools", label: "Agent 工具", group: "工具", icon: "bx-wrench", scope: "agent" },
  { id: "bash", label: "命令执行", group: "工具", icon: "bx-terminal", scope: "agent" },
  { id: "providers", label: "模型服务", group: "公共系统", icon: "bx-chip", scope: "system" },
  { id: "normalReply", label: "回复重试", group: "公共系统", icon: "bx-refresh", scope: "system" },
  { id: "broadcastStorm", label: "广播风暴", group: "公共系统", icon: "bx-shield-quarter", scope: "system" },
  { id: "security", label: "账户安全", group: "公共系统", icon: "bx-lock-alt", scope: "system" },
  { id: "onebot", label: "连接与通知", group: "公共系统", icon: "bx-link", scope: "system" }
];
const sections = computed(() => allSections.filter((section) => section.scope === props.scope));
const visibleSections = computed(() => new Set(sections.value.map((section) => section.id)));
const configSections = new Set<ConfigSectionKey>(sectionKeys);
const current = computed<SettingsSectionKey>(() => {
  const fallback = props.scope === "agent" ? "persona" : "providers";
  const value = String(route.params.section ?? fallback) as SettingsSectionKey;
  return visibleSections.value.has(value) ? value : fallback;
});
const currentState = computed(() => {
  const section = isConfigSection(current.value) ? current.value : "persona";
  const candidates = section === "bot"
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
  await Promise.all([loadConfig(), catalog.load()]);
});
onBeforeUnmount(() => workspace.cancel());

watch(activeAgentIdState, () => {
  if (props.scope === "agent") void loadConfig();
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

async function loadConfig(preserveDirty = false) {
  try {
    await workspace.load({ preserveDirty });
    loadError.value = "";
  } catch (error) {
    loadError.value = error instanceof Error ? error.message : "配置读取失败";
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
          <button class="btn btn-ghost" type="button" @click="logoutConfirmOpen = true"><i class="bx bx-log-out" aria-hidden="true"></i>退出登录</button>
        </template>
      </PageHeader>

      <div v-if="workspace.loading.value && !workspace.envelope.value" class="empty-state"><div><strong>加载中</strong></div></div>
      <div v-else-if="loadError" class="empty-state"><div><strong class="!text-accent">{{ loadError }}</strong><button class="btn mt-4" type="button" @click="loadConfig()">重试</button></div></div>
      <div v-else class="mt-8 grid min-w-0 gap-8 lg:grid-cols-[176px_minmax(0,1fr)] xl:grid-cols-[208px_minmax(0,880px)] xl:gap-12">
        <SettingsNavigation :current="current" :sections="sections" @select="selectSection" />
        <section
          ref="settingsPanel"
          class="min-w-0"
          @change="handleControlChange"
          @click="handleSettingsClick"
          @keydown="handleSettingsKeydown"
        >
          <div v-if="current === 'persona'" class="grid gap-12">
            <PersonaSettingsForm :agent-id="activeAgentId()" />
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
            <MonitoringSettingsForm ref="monitoringForm" />
            <OneBotSettingsForm
              v-model="workspace.drafts.onebot"
              :field-states="workspace.envelope.value?.fieldStates"
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
