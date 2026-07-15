<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, shallowRef, useTemplateRef } from "vue";
import { onBeforeRouteLeave, useRoute, useRouter } from "vue-router";
import { useConfigWorkspace, sectionKeys } from "../composables/useConfigWorkspace";
import { useModelCatalog } from "../composables/useModelCatalog";
import { apiRequest } from "../composables/useAdminApi";
import type { ConfigSectionKey, SettingsSectionKey } from "../types";
import { focusConfigField } from "../utils/configFieldFocus";
import PageHeader from "../components/ui/PageHeader.vue";
import SettingsNavigation from "../components/settings/SettingsNavigation.vue";
import SettingsSaveBar from "../components/settings/SettingsSaveBar.vue";
import PersonaSettingsForm from "../components/settings/PersonaSettingsForm.vue";
import ProviderSettings from "../components/settings/ProviderSettings.vue";
import BroadcastStormSettingsForm from "../components/settings/BroadcastStormSettingsForm.vue";
import NormalReplySettingsForm from "../components/settings/NormalReplySettingsForm.vue";
import BotSettingsForm from "../components/settings/BotSettingsForm.vue";
import MemorySettingsForm from "../components/settings/MemorySettingsForm.vue";
import OrchestratorSettingsForm from "../components/settings/OrchestratorSettingsForm.vue";
import ToolsSettingsForm from "../components/settings/ToolsSettingsForm.vue";
import BashSettingsForm from "../components/settings/BashSettingsForm.vue";
import OneBotSettingsForm from "../components/settings/OneBotSettingsForm.vue";
import MonitoringSettingsForm from "../components/settings/MonitoringSettingsForm.vue";
import DialogOverlay from "../components/ui/DialogOverlay.vue";
import AdminPasswordForm from "../components/settings/AdminPasswordForm.vue";
import { activeAgentId } from "../composables/agentScope";

const props = withDefaults(defineProps<{ scope?: "agent" | "system" }>(), { scope: "agent" });

const route = useRoute();
const router = useRouter();
const workspace = useConfigWorkspace(props.scope);
const catalog = useModelCatalog();
const loadError = shallowRef("");
const leaveConfirmOpen = shallowRef(false);
const pendingLeavePath = shallowRef("");
const savingBeforeLeave = shallowRef(false);
const leaveSaveError = shallowRef("");
const logoutConfirmOpen = shallowRef(false);
const loggingOut = shallowRef(false);
const logoutError = shallowRef("");
const settingsPanel = useTemplateRef<HTMLElement>("settingsPanel");
const allSections: Array<{ id: SettingsSectionKey; label: string; group: string; icon: string; scope: "agent" | "system" }> = [
  { id: "persona", label: "Agent 身份", group: "Agent", icon: "bx-user-voice", scope: "agent" },
  { id: "bot", label: "回复行为", group: "Agent", icon: "bx-bot", scope: "agent" },
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
  if (section === "bot" && ["saving", "error", "conflict"].includes(workspace.state.onebot.kind)) {
    return workspace.state.onebot;
  }
  if (section === "tools" && ["saving", "error", "conflict"].includes(workspace.state.bash.kind)) {
    return workspace.state.bash;
  }
  if (section === "tools" && ["saving", "error", "conflict"].includes(workspace.state.bot.kind)) {
    return workspace.state.bot;
  }
  return workspace.state[section];
});
const anyDirty = computed(() => sections.value.some((section) => isNavigationDirty(section.id)));
const currentDirty = computed(() => current.value === "orchestrator"
  ? workspace.isGroupReplyDirty()
  : current.value === "bot"
    ? workspace.isDirty("bot") || workspace.isReplyBehaviorDirty()
  : current.value === "tools"
    ? workspace.isDirty("tools") || workspace.isDirty("bash") || workspace.isNoReplyPokeDirty()
  : current.value === "onebot"
    ? workspace.isOneBotConnectionDirty()
  : isConfigSection(current.value) ? workspace.isDirty(current.value) : false);

onMounted(async () => {
  window.addEventListener("beforeunload", onBeforeUnload);
  await Promise.all([loadConfig(), catalog.load()]);
});
onBeforeUnmount(() => window.removeEventListener("beforeunload", onBeforeUnload));

onBeforeRouteLeave((to) => {
  if (!anyDirty.value) return true;
  pendingLeavePath.value = to.fullPath;
  leaveConfirmOpen.value = true;
  return false;
});

async function loadConfig(preserveDirty = false, discardDirtySection?: ConfigSectionKey) {
  try {
    await workspace.load({ preserveDirty, discardDirtySection });
    loadError.value = "";
  } catch (error) {
    loadError.value = error instanceof Error ? error.message : "配置读取失败";
  }
}

async function saveCurrent() {
  if (!isConfigSection(current.value)) return;
  if (current.value === "orchestrator") {
    await workspace.saveGroupReply();
  } else if (current.value === "bot") {
    if (workspace.isDirty("bot")) await workspace.save("bot");
    if (workspace.isReplyBehaviorDirty()) await workspace.save("onebot");
  } else if (current.value === "tools") {
    if (workspace.isDirty("tools")) await workspace.save("tools");
    if (workspace.isDirty("bash")) await workspace.save("bash");
    if (workspace.isNoReplyPokeDirty()) await workspace.save("bot");
  } else {
    await workspace.save(current.value);
  }
  const savedState = currentState.value;
  if (savedState.kind !== "error" || !savedState.field || !settingsPanel.value) return;
  await nextTick();
  focusConfigField(settingsPanel.value, savedState.field);
}

function reloadConflict() {
  if (!isConfigSection(current.value)) return;
  if (current.value === "orchestrator") {
    workspace.discardGroupReply();
    return loadConfig(true);
  }
  if (current.value === "bot" && workspace.state.onebot.kind === "conflict") {
    return loadConfig(true, "onebot");
  }
  if (current.value === "tools" && workspace.state.bash.kind === "conflict") {
    return loadConfig(true, "bash");
  }
  if (current.value === "tools" && workspace.state.bot.kind === "conflict") {
    return loadConfig(true, "bot");
  }
  return loadConfig(true, current.value);
}

function discardCurrent() {
  if (!isConfigSection(current.value)) return;
  if (current.value === "orchestrator") workspace.discardGroupReply();
  else if (current.value === "bot") {
    workspace.discard("bot");
    workspace.discardReplyBehavior();
  } else if (current.value === "tools") {
    workspace.discard("tools");
    workspace.discard("bash");
    workspace.discardNoReplyPoke();
  } else if (current.value === "onebot") workspace.discardOneBotConnection();
  else workspace.discard(current.value);
}

function isNavigationDirty(section: SettingsSectionKey) {
  if (!isConfigSection(section)) return false;
  if (section === "orchestrator") return workspace.isGroupReplyDirty();
  if (section === "bot") return workspace.isDirty("bot") || workspace.isReplyBehaviorDirty();
  if (section === "tools") return workspace.isDirty("tools") || workspace.isDirty("bash") || workspace.isNoReplyPokeDirty();
  if (section === "onebot") return workspace.isOneBotConnectionDirty();
  return workspace.isDirty(section);
}

function selectSection(section: SettingsSectionKey) {
  void router.push(`/${props.scope === "agent" ? "agent-settings" : "settings"}/${section}`);
}

function isConfigSection(section: SettingsSectionKey): section is ConfigSectionKey {
  return configSections.has(section as ConfigSectionKey);
}

function onBeforeUnload(event: BeforeUnloadEvent) {
  if (!anyDirty.value) return;
  event.preventDefault();
  event.returnValue = "";
}

function cancelLeave() {
  if (savingBeforeLeave.value) return;
  leaveConfirmOpen.value = false;
  pendingLeavePath.value = "";
  leaveSaveError.value = "";
}

function confirmLeave() {
  if (savingBeforeLeave.value) return;
  const path = pendingLeavePath.value;
  workspace.discardGroupReply();
  for (const section of sectionKeys) {
    if (section !== "orchestrator") workspace.discard(section);
  }
  leaveConfirmOpen.value = false;
  pendingLeavePath.value = "";
  leaveSaveError.value = "";
  if (path) void router.push(path);
}

async function saveAndLeave() {
  const path = pendingLeavePath.value;
  savingBeforeLeave.value = true;
  leaveSaveError.value = "";
  try {
    if (workspace.isGroupReplyDirty()) {
      await workspace.saveGroupReply();
      if (workspace.isGroupReplyDirty()) throw new Error(workspace.state.orchestrator.message || "群聊编排保存失败");
    }
    for (const section of sectionKeys) {
      if (section === "orchestrator") continue;
      const dirty = section === "onebot" ? workspace.isOneBotSettingsDirty() : workspace.isDirty(section);
      if (!dirty) continue;
      await workspace.save(section);
      const stillDirty = section === "onebot" ? workspace.isOneBotSettingsDirty() : workspace.isDirty(section);
      if (stillDirty) throw new Error(workspace.state[section].message || "设置保存失败");
    }
    leaveConfirmOpen.value = false;
    pendingLeavePath.value = "";
    if (path) await router.push(path);
  } catch (error) {
    leaveSaveError.value = error instanceof Error ? error.message : "设置保存失败";
  } finally {
    savingBeforeLeave.value = false;
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
        <SettingsNavigation :current="current" :sections="sections" :dirty="isNavigationDirty" @select="selectSection" />
        <section ref="settingsPanel" class="min-w-0">
          <div v-if="current === 'persona'" class="grid gap-12">
            <PersonaSettingsForm :agent-id="activeAgentId()" />
          </div>
          <ProviderSettings
            v-else-if="current === 'providers'"
            v-model="workspace.drafts.providers"
            :models="catalog.models.value"
            :field-states="workspace.envelope.value?.fieldStates"
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
          />
          <BashSettingsForm v-else-if="current === 'bash'" v-model="workspace.drafts.bash" />
          <AdminPasswordForm v-else-if="current === 'security'" />
          <div v-else class="grid gap-12">
            <MonitoringSettingsForm />
            <OneBotSettingsForm
              v-model="workspace.drafts.onebot"
              :field-states="workspace.envelope.value?.fieldStates"
            />
          </div>

          <SettingsSaveBar
            v-if="current !== 'security' && current !== 'persona'"
            :dirty="currentDirty"
            :busy="currentState.kind === 'saving'"
            :message="currentState.message"
            :kind="currentState.kind"
            :field="currentState.field"
            @save="saveCurrent"
            @discard="discardCurrent"
            @reload="reloadConflict"
          />
        </section>
      </div>
    </div>
  </div>

  <DialogOverlay :open="leaveConfirmOpen" labelledby="settings-leave-title" @close="cancelLeave">
    <section class="w-full max-w-md rounded border border-visible bg-panel p-6">
      <h2 id="settings-leave-title" class="text-xl font-medium text-display">放弃未保存的设置？</h2>
      <p class="mt-3 text-sm leading-6 text-mute">离开后，本次修改不会保留。</p>
      <p v-if="leaveSaveError" class="mt-4 inline-state" data-kind="error">{{ leaveSaveError }}</p>
      <div class="mt-8 flex flex-wrap justify-end gap-2">
        <button class="btn btn-ghost" type="button" :disabled="savingBeforeLeave" @click="cancelLeave">继续编辑</button>
        <button class="btn btn-primary" type="button" :disabled="savingBeforeLeave" @click="saveAndLeave"><i class="bx bx-save" aria-hidden="true"></i>{{ savingBeforeLeave ? "保存中" : "保存并离开" }}</button>
        <button class="btn btn-danger" type="button" :disabled="savingBeforeLeave" @click="confirmLeave">放弃并离开</button>
      </div>
    </section>
  </DialogOverlay>

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
