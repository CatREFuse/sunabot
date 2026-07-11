<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, shallowRef, useTemplateRef } from "vue";
import { onBeforeRouteLeave, useRoute, useRouter } from "vue-router";
import { useConfigWorkspace, sectionKeys } from "../composables/useConfigWorkspace";
import { useModelCatalog } from "../composables/useModelCatalog";
import type { ConfigSectionKey } from "../types";
import { focusConfigField } from "../utils/configFieldFocus";
import PageHeader from "../components/ui/PageHeader.vue";
import SettingsNavigation from "../components/settings/SettingsNavigation.vue";
import SettingsSaveBar from "../components/settings/SettingsSaveBar.vue";
import ServerSettingsForm from "../components/settings/ServerSettingsForm.vue";
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
const settingsPanel = useTemplateRef<HTMLElement>("settingsPanel");
const sections: Array<{ id: ConfigSectionKey; label: string; meta: string }> = [
  { id: "server", label: "服务", meta: "01" },
  { id: "persona", label: "Agent", meta: "02" },
  { id: "providers", label: "Provider", meta: "03" },
  { id: "bot", label: "Bot", meta: "04" },
  { id: "memory", label: "记忆", meta: "05" },
  { id: "orchestrator", label: "编排器", meta: "06" },
  { id: "tools", label: "工具", meta: "07" },
  { id: "bash", label: "Bash", meta: "08" },
  { id: "onebot", label: "OneBot", meta: "09" }
];
const current = computed<ConfigSectionKey>(() => {
  const value = String(route.params.section ?? "server") as ConfigSectionKey;
  return sectionKeys.includes(value) ? value : "server";
});
const currentState = computed(() => workspace.state[current.value]);
const anyDirty = computed(() => sectionKeys.some(workspace.isDirty));
const currentDirty = computed(() => current.value === "orchestrator"
  ? workspace.isGroupReplyDirty()
  : current.value === "onebot"
    ? workspace.isOneBotSettingsDirty()
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
    loadError.value = `[ERROR: ${error instanceof Error ? error.message : "配置读取失败"}]`;
  }
}

async function saveCurrent() {
  if (current.value === "orchestrator") await workspace.saveGroupReply();
  else await workspace.save(current.value);
  const savedState = workspace.state[current.value];
  if (savedState.kind !== "error" || !savedState.field || !settingsPanel.value) return;
  await nextTick();
  focusConfigField(settingsPanel.value, savedState.field);
}

function reloadConflict() {
  if (current.value === "orchestrator") {
    workspace.discardGroupReply();
    return loadConfig(true);
  }
  return loadConfig(true, current.value);
}

function discardCurrent() {
  if (current.value === "orchestrator") workspace.discardGroupReply();
  else workspace.discard(current.value);
}

function isNavigationDirty(section: ConfigSectionKey) {
  if (section === "orchestrator") return workspace.isGroupReplyDirty();
  if (section === "onebot") return workspace.isOneBotSettingsDirty();
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
  leaveConfirmOpen.value = false;
  pendingLeavePath.value = "";
}

function confirmLeave() {
  const path = pendingLeavePath.value;
  for (const section of sectionKeys) workspace.discard(section);
  leaveConfirmOpen.value = false;
  pendingLeavePath.value = "";
  if (path) void router.push(path);
}
</script>

<template>
  <div class="page-shell">
    <div class="page-frame">
      <PageHeader kicker="SETTINGS" title="设置">
        <template #actions>
          <span v-if="workspace.envelope.value" class="font-mono text-[10px] text-mute">REV {{ workspace.envelope.value.revision.slice(0, 8) }}</span>
          <button class="btn" type="button" :disabled="workspace.loading.value" @click="loadConfig(true)">刷新</button>
        </template>
      </PageHeader>

      <div v-if="workspace.loading.value && !workspace.envelope.value" class="empty-state"><div><strong>[LOADING...]</strong><p>正在读取配置</p></div></div>
      <div v-else-if="loadError" class="empty-state"><div><strong class="!text-accent">{{ loadError }}</strong><p>检查管理 API 后重试</p></div></div>
      <div v-else class="mt-8 grid min-w-0 gap-8 lg:grid-cols-[176px_minmax(0,1fr)] xl:grid-cols-[208px_minmax(0,880px)] xl:gap-12">
        <SettingsNavigation :current="current" :sections="sections" :dirty="isNavigationDirty" @select="selectSection" />
        <section ref="settingsPanel" class="min-w-0">
          <ServerSettingsForm v-if="current === 'server'" v-model="workspace.drafts.server" />
          <PersonaSettingsForm v-else-if="current === 'persona'" v-model="workspace.drafts.persona" />
          <ProviderSettings
            v-else-if="current === 'providers'"
            v-model="workspace.drafts.providers"
            :models="catalog.models.value"
            :field-states="workspace.envelope.value?.fieldStates"
          />
          <BotSettingsForm v-else-if="current === 'bot'" v-model="workspace.drafts.bot" />
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
          />
          <BashSettingsForm v-else-if="current === 'bash'" v-model="workspace.drafts.bash" />
          <div v-else class="grid gap-8">
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
    <section class="w-full max-w-md rounded-2xl border border-visible bg-panel p-6">
      <p class="page-kicker">UNSAVED SETTINGS</p>
      <h2 id="settings-leave-title" class="mt-2 text-xl font-medium text-display">放弃未保存的设置？</h2>
      <p class="mt-3 text-sm leading-6 text-mute">离开后，本次修改不会保留。</p>
      <div class="mt-8 flex flex-wrap justify-end gap-2">
        <button class="btn btn-ghost" type="button" @click="cancelLeave">继续编辑</button>
        <button class="btn btn-danger" type="button" @click="confirmLeave">放弃并离开</button>
      </div>
    </section>
  </DialogOverlay>
</template>
