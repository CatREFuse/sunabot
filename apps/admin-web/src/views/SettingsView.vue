<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, shallowRef, useTemplateRef } from "vue";
import { onBeforeRouteLeave, useRoute, useRouter } from "vue-router";
import { useConfigWorkspace, sectionKeys } from "../composables/useConfigWorkspace";
import { useModelCatalog } from "../composables/useModelCatalog";
import { apiRequest } from "../composables/useAdminApi";
import type { ConfigSectionKey } from "../types";
import { focusConfigField } from "../utils/configFieldFocus";
import PageHeader from "../components/ui/PageHeader.vue";
import SettingsNavigation from "../components/settings/SettingsNavigation.vue";
import SettingsSaveBar from "../components/settings/SettingsSaveBar.vue";
import PersonaSettingsForm from "../components/settings/PersonaSettingsForm.vue";
import ProviderSettings from "../components/settings/ProviderSettings.vue";
import BotSettingsForm from "../components/settings/BotSettingsForm.vue";
import MemorySettingsForm from "../components/settings/MemorySettingsForm.vue";
import OrchestratorSettingsForm from "../components/settings/OrchestratorSettingsForm.vue";
import ToolsSettingsForm from "../components/settings/ToolsSettingsForm.vue";
import BashSettingsForm from "../components/settings/BashSettingsForm.vue";
import OneBotSettingsForm from "../components/settings/OneBotSettingsForm.vue";
import MonitoringSettingsForm from "../components/settings/MonitoringSettingsForm.vue";
import DialogOverlay from "../components/ui/DialogOverlay.vue";

const route = useRoute();
const router = useRouter();
const workspace = useConfigWorkspace();
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
const sections: Array<{ id: ConfigSectionKey; label: string; group: string; icon: string }> = [
  { id: "persona", label: "Agent 身份", group: "Agent", icon: "bx-user-voice" },
  { id: "bot", label: "回复行为", group: "Agent", icon: "bx-bot" },
  { id: "providers", label: "模型服务", group: "模型与记忆", icon: "bx-chip" },
  { id: "memory", label: "记忆处理", group: "模型与记忆", icon: "bx-brain" },
  { id: "orchestrator", label: "群聊编排", group: "模型与记忆", icon: "bx-git-branch" },
  { id: "tools", label: "Agent 工具", group: "工具", icon: "bx-wrench" },
  { id: "bash", label: "命令执行", group: "工具", icon: "bx-terminal" },
  { id: "onebot", label: "连接与通知", group: "系统", icon: "bx-link" }
];
const visibleSections = new Set(sections.map((section) => section.id));
const current = computed<ConfigSectionKey>(() => {
  const value = String(route.params.section ?? "persona") as ConfigSectionKey;
  return visibleSections.has(value) ? value : "persona";
});
const currentState = computed(() => {
  if (current.value === "bot" && ["saving", "error", "conflict"].includes(workspace.state.onebot.kind)) {
    return workspace.state.onebot;
  }
  if (current.value === "tools" && ["saving", "error", "conflict"].includes(workspace.state.bash.kind)) {
    return workspace.state.bash;
  }
  return workspace.state[current.value];
});
const anyDirty = computed(() => sectionKeys.some(workspace.isDirty));
const currentDirty = computed(() => current.value === "orchestrator"
  ? workspace.isGroupReplyDirty()
  : current.value === "bot"
    ? workspace.isDirty("bot") || workspace.isReplyBehaviorDirty()
  : current.value === "tools"
    ? workspace.isDirty("tools") || workspace.isDirty("bash")
  : current.value === "onebot"
    ? workspace.isOneBotConnectionDirty()
  : workspace.isDirty(current.value));

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
  if (current.value === "orchestrator") {
    await workspace.saveGroupReply();
  } else if (current.value === "bot") {
    if (workspace.isDirty("bot")) await workspace.save("bot");
    if (workspace.isReplyBehaviorDirty()) await workspace.save("onebot");
  } else if (current.value === "tools") {
    if (workspace.isDirty("tools")) await workspace.save("tools");
    if (workspace.isDirty("bash")) await workspace.save("bash");
  } else {
    await workspace.save(current.value);
  }
  const savedState = currentState.value;
  if (savedState.kind !== "error" || !savedState.field || !settingsPanel.value) return;
  await nextTick();
  focusConfigField(settingsPanel.value, savedState.field);
}

function reloadConflict() {
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
  return loadConfig(true, current.value);
}

function discardCurrent() {
  if (current.value === "orchestrator") workspace.discardGroupReply();
  else if (current.value === "bot") {
    workspace.discard("bot");
    workspace.discardReplyBehavior();
  } else if (current.value === "tools") {
    workspace.discard("tools");
    workspace.discard("bash");
  } else if (current.value === "onebot") workspace.discardOneBotConnection();
  else workspace.discard(current.value);
}

function isNavigationDirty(section: ConfigSectionKey) {
  if (section === "orchestrator") return workspace.isGroupReplyDirty();
  if (section === "bot") return workspace.isDirty("bot") || workspace.isReplyBehaviorDirty();
  if (section === "tools") return workspace.isDirty("tools") || workspace.isDirty("bash");
  if (section === "onebot") return workspace.isOneBotConnectionDirty();
  return workspace.isDirty(section);
}

function selectSection(section: ConfigSectionKey) {
  void router.push(`/settings/${section}`);
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
      <PageHeader title="设置">
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
            <PersonaSettingsForm v-model="workspace.drafts.persona" />
          </div>
          <ProviderSettings
            v-else-if="current === 'providers'"
            v-model="workspace.drafts.providers"
            :models="catalog.models.value"
            :field-states="workspace.envelope.value?.fieldStates"
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
          />
          <BashSettingsForm v-else-if="current === 'bash'" v-model="workspace.drafts.bash" />
          <div v-else class="grid gap-12">
            <MonitoringSettingsForm />
            <OneBotSettingsForm
              v-model="workspace.drafts.onebot"
              :field-states="workspace.envelope.value?.fieldStates"
            />
          </div>

          <SettingsSaveBar
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
