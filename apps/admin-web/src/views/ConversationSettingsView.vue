<script setup lang="ts">
import { computed, onBeforeUnmount, watch } from "vue";
import { onBeforeRouteLeave, onBeforeRouteUpdate, useRoute, useRouter } from "vue-router";
import ConversationBehaviorSettings from "../components/conversations/ConversationBehaviorSettings.vue";
import ConversationToolSettingsForm from "../components/conversations/ConversationToolSettingsForm.vue";
import PageHeader from "../components/ui/PageHeader.vue";
import SettingsAutoSaveStatus from "../components/settings/SettingsAutoSaveStatus.vue";
import { activeAgentIdState } from "../composables/agentScope";
import { useConversationSettings } from "../composables/useConversationSettings";
import { conversationIdentityDetail } from "../utils/qqIdentity";

type SettingsSection = "general" | "tools";
const route = useRoute();
const router = useRouter();
const conversationId = computed(() => String(route.params.conversationId ?? "").trim());
const settings = useConversationSettings(conversationId);
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

watch([conversationId, activeAgentIdState], () => { void settings.load(true); }, { immediate: true });
onBeforeUnmount(settings.dispose);
onBeforeRouteLeave(() => settings.flush());
onBeforeRouteUpdate((to) => String(to.params.conversationId ?? "").trim() === conversationId.value
  ? true
  : settings.flush());

function selectSection(section: SettingsSection) {
  void router.push(`/conversations/${encodeURIComponent(conversationId.value)}/settings/${section}`);
}

async function refresh() {
  if (await settings.flush()) await settings.load(true);
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
          <button class="btn" type="button" :disabled="settings.loading.value" @click="refresh">
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
            <i class="bx mr-1" :class="section.icon" aria-hidden="true"></i>{{ section.label }}
          </button>
        </nav>

        <main class="mt-8 max-w-4xl min-w-0">
          <template v-if="current === 'general'">
            <ConversationBehaviorSettings
              :conversation="settings.conversation.value"
              :reply-enabled="settings.replyEnabled.value"
              :orchestrator-enabled="settings.orchestratorEnabled.value"
              :orchestrator-response-time-override-enabled="settings.orchestratorResponseTimeOverrideEnabled.value"
              :orchestrator-response-time-seconds="settings.orchestratorResponseTimeSeconds.value"
              :director-events-enabled="settings.directorEventsEnabled.value"
              :busy="settings.loading.value"
              @update-reply-enabled="settings.setReplyEnabled"
              @update-orchestrator-enabled="settings.setOrchestratorEnabled"
              @update-orchestrator-response-time-override-enabled="settings.setOrchestratorResponseTimeOverrideEnabled"
              @update-orchestrator-response-time-seconds="settings.setOrchestratorResponseTimeSeconds"
              @update-director-events-enabled="settings.setDirectorEventsEnabled"
            />
            <SettingsAutoSaveStatus
              :kind="settings.behaviorState.value.kind"
              :message="settings.behaviorState.value.message"
            />
          </template>
          <template v-else>
            <ConversationToolSettingsForm
              :tools="settings.tools.value"
              :disabled-tools="settings.disabledTools.value"
              :loading="settings.loading.value"
              :busy="settings.loading.value"
              @toggle="settings.setToolEnabled"
            />
            <SettingsAutoSaveStatus
              :kind="settings.toolState.value.kind"
              :message="settings.toolState.value.message"
            />
          </template>
        </main>
      </template>
    </div>
  </div>

</template>
