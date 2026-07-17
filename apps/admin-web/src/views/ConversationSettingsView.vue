<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, shallowRef, watch } from "vue";
import { onBeforeRouteLeave, onBeforeRouteUpdate, useRoute, useRouter, type RouteLocationNormalized } from "vue-router";
import ConversationBehaviorSettings from "../components/conversations/ConversationBehaviorSettings.vue";
import ConversationToolSettingsForm from "../components/conversations/ConversationToolSettingsForm.vue";
import DialogOverlay from "../components/ui/DialogOverlay.vue";
import PageHeader from "../components/ui/PageHeader.vue";
import SettingsSaveBar from "../components/settings/SettingsSaveBar.vue";
import { useConversationSettings } from "../composables/useConversationSettings";
import { conversationIdentityDetail } from "../utils/qqIdentity";

type SettingsSection = "general" | "tools";
const route = useRoute();
const router = useRouter();
const conversationId = computed(() => String(route.params.conversationId ?? "").trim());
const settings = useConversationSettings(conversationId);
const leaveConfirmOpen = shallowRef(false);
const pendingLeavePath = shallowRef("");
const savingBeforeLeave = shallowRef(false);
const leaveSaveError = shallowRef("");
const sections = computed<Array<{ id: SettingsSection; label: string; icon: string }>>(() => settings.isWebChat.value
  ? [{ id: "tools", label: "工具权限", icon: "bx-wrench" }]
  : [
      { id: "general", label: "回复", icon: "bx-message-rounded-dots" },
      { id: "tools", label: "工具权限", icon: "bx-wrench" }
    ]);
const current = computed<SettingsSection>(() => {
  const requested = String(route.params.section ?? "");
  if (settings.isWebChat.value) return "tools";
  return requested === "tools" ? "tools" : "general";
});
const backTo = computed(() => settings.isWebChat.value
  ? "/web-chat"
  : `/conversations/${encodeURIComponent(conversationId.value)}`);
const behaviorKind = computed(() => settings.behaviorError.value ? "error" : settings.behaviorMessage.value ? "saved" : "");
const toolKind = computed(() => settings.toolError.value ? "error" : settings.toolMessage.value ? "saved" : "");
const anyDirty = computed(() => settings.behaviorDirty.value || settings.toolsDirty.value);

watch(conversationId, () => { void settings.load(true); }, { immediate: true });
onMounted(() => window.addEventListener("beforeunload", onBeforeUnload));
onBeforeUnmount(() => {
  window.removeEventListener("beforeunload", onBeforeUnload);
  settings.dispose();
});
onBeforeRouteLeave((to) => guardNavigation(to));
onBeforeRouteUpdate((to) => String(to.params.conversationId ?? "").trim() === conversationId.value
  ? true
  : guardNavigation(to));

function selectSection(section: SettingsSection) {
  void router.push(`/conversations/${encodeURIComponent(conversationId.value)}/settings/${section}`);
}

function sectionDirty(section: SettingsSection) {
  return section === "general" ? settings.behaviorDirty.value : settings.toolsDirty.value;
}

function guardNavigation(to: RouteLocationNormalized) {
  if (!anyDirty.value) return true;
  pendingLeavePath.value = to.fullPath;
  leaveConfirmOpen.value = true;
  return false;
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
  settings.discardBehavior();
  settings.discardTools();
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
    if (settings.behaviorDirty.value && !await settings.saveBehavior()) {
      throw new Error(settings.behaviorError.value || "回复设置保存失败");
    }
    if (settings.toolsDirty.value && !await settings.saveTools()) {
      throw new Error(settings.toolError.value || "工具权限保存失败");
    }
    leaveConfirmOpen.value = false;
    pendingLeavePath.value = "";
    if (path) await router.push(path);
  } catch (error) {
    leaveSaveError.value = error instanceof Error ? error.message : "会话设置保存失败";
  } finally {
    savingBeforeLeave.value = false;
  }
}

function scopeLabel() {
  const conversation = settings.conversation.value;
  if (!conversation) return "";
  if (settings.isWebChat.value) return "Web Chat";
  if (conversation.scope === "private") return "私聊";
  if (conversation.scope === "bot_group") return "BOT 群聊";
  return "群聊";
}
</script>

<template>
  <div class="page-shell">
    <div class="page-frame">
      <PageHeader title="会话设置">
        <template #titleAfter>
          <span v-if="settings.conversation.value" class="block truncate text-sm text-mute">{{ settings.conversation.value.title }}</span>
        </template>
        <template #actions>
          <button class="btn" type="button" :disabled="settings.loading.value || anyDirty" @click="settings.load(true)">
            <i class="bx bx-refresh" aria-hidden="true"></i>刷新
          </button>
          <RouterLink class="btn btn-ghost" :to="backTo">
            <i class="bx bx-left-arrow-alt" aria-hidden="true"></i>返回会话
          </RouterLink>
        </template>
      </PageHeader>

      <div v-if="settings.loading.value && !settings.conversation.value" class="empty-state">
        <div><strong>加载中</strong></div>
      </div>
      <div v-else-if="settings.loadError.value" class="empty-state">
        <div>
          <strong class="!text-accent">{{ settings.loadError.value }}</strong>
          <button class="btn mt-4" type="button" @click="settings.load(true)">重试</button>
        </div>
      </div>
      <template v-else-if="settings.conversation.value">
        <div class="flex min-w-0 flex-wrap items-center gap-x-5 gap-y-2 border-y border-line py-4">
          <strong class="truncate text-sm font-medium text-display">{{ settings.conversation.value.title }}</strong>
          <span class="font-mono text-[10px] text-mute">{{ scopeLabel() }}</span>
          <span v-if="!settings.isWebChat.value" class="truncate font-mono text-[10px] text-disabled">{{ conversationIdentityDetail(settings.conversation.value) }}</span>
          <span class="truncate font-mono text-[10px] text-disabled">{{ settings.conversation.value.id }}</span>
        </div>

        <nav class="mt-8 segmented" aria-label="会话设置分区">
          <button
            v-for="section in sections"
            :key="section.id"
            class="segmented-button"
            type="button"
            :aria-pressed="current === section.id"
            @click="selectSection(section.id)"
          >
            <i class="bx mr-1" :class="section.icon" aria-hidden="true"></i>{{ section.label }}{{ sectionDirty(section.id) ? " · 未保存" : "" }}
          </button>
        </nav>

        <main class="mt-8 max-w-4xl min-w-0">
          <template v-if="current === 'general'">
            <ConversationBehaviorSettings
              :conversation="settings.conversation.value"
              :reply-enabled="settings.replyEnabled.value"
              :orchestrator-enabled="settings.orchestratorEnabled.value"
              :busy="settings.behaviorSaving.value"
              @update-reply-enabled="settings.setReplyEnabled"
              @update-orchestrator-enabled="settings.setOrchestratorEnabled"
            />
            <SettingsSaveBar
              :dirty="settings.behaviorDirty.value"
              :busy="settings.behaviorSaving.value"
              :message="settings.behaviorError.value || settings.behaviorMessage.value"
              :kind="behaviorKind"
              @save="settings.saveBehavior"
              @discard="settings.discardBehavior"
            />
          </template>
          <template v-else>
            <ConversationToolSettingsForm
              :tools="settings.tools.value"
              :disabled-tools="settings.disabledTools.value"
              :loading="settings.loading.value"
              :busy="settings.loading.value || settings.toolSaving.value"
              @toggle="settings.setToolEnabled"
            />
            <SettingsSaveBar
              :dirty="settings.toolsDirty.value"
              :busy="settings.loading.value || settings.toolSaving.value"
              :message="settings.toolError.value || settings.toolMessage.value"
              :kind="toolKind"
              @save="settings.saveTools"
              @discard="settings.discardTools"
            />
          </template>
        </main>
      </template>
    </div>
  </div>

  <DialogOverlay :open="leaveConfirmOpen" labelledby="conversation-settings-leave-title" @close="cancelLeave">
    <section class="w-full max-w-md rounded border border-visible bg-panel p-6">
      <h2 id="conversation-settings-leave-title" class="text-xl font-medium text-display">放弃未保存的设置？</h2>
      <p class="mt-3 text-sm leading-6 text-mute">离开后，本次修改不会保留。</p>
      <p v-if="leaveSaveError" class="mt-4 inline-state" data-kind="error">{{ leaveSaveError }}</p>
      <div class="mt-8 flex flex-wrap justify-end gap-2">
        <button class="btn btn-ghost" type="button" :disabled="savingBeforeLeave" @click="cancelLeave">继续编辑</button>
        <button class="btn btn-primary" type="button" :disabled="savingBeforeLeave" @click="saveAndLeave"><i class="bx bx-save" aria-hidden="true"></i>{{ savingBeforeLeave ? "保存中" : "保存并离开" }}</button>
        <button class="btn btn-danger" type="button" :disabled="savingBeforeLeave" @click="confirmLeave">放弃并离开</button>
      </div>
    </section>
  </DialogOverlay>
</template>
