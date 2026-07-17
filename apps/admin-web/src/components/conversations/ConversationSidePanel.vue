<script setup lang="ts">
import { computed, onBeforeUnmount, shallowRef, watch } from "vue";
import { useConversationTools } from "../../composables/useConversationTools";
import type { ConversationRecord, ConversationStatsPayload, ToolName } from "../../types";
import { conversationIdentityDetail } from "../../utils/qqIdentity";
import ModelCallStatsPanel from "../logs/ModelCallStatsPanel.vue";
import DialogOverlay from "../ui/DialogOverlay.vue";
import ToggleSwitch from "../ui/ToggleSwitch.vue";
import ConversationOrchestratorStatus from "./ConversationOrchestratorStatus.vue";
import ConversationToolSettingsForm from "./ConversationToolSettingsForm.vue";

const props = defineProps<{
  open: boolean;
  panel: "settings" | "usage";
  conversation: ConversationRecord;
  stats?: ConversationStatsPayload | null;
}>();
const emit = defineEmits<{
  close: [];
  reply: [enabled: boolean];
  orchestrator: [enabled: boolean];
}>();
const settingsSection = shallowRef<"general" | "tools">("general");
const toolPolicy = useConversationTools(() => props.conversation.id);
const disabledTools = shallowRef<ToolName[]>([]);
const toolStatus = shallowRef("");
const toolStatusKind = shallowRef<"saved" | "error" | "">("");

const title = computed(() => props.panel === "settings" ? "会话设置" : "Token 消耗详情");
const titleId = computed(() => props.panel === "settings" ? "conversation-settings-title" : "conversation-usage-title");
const closeLabel = computed(() => props.panel === "settings" ? "关闭会话设置" : "关闭 Token 消耗详情");
const replyEnabled = computed({
  get: () => props.conversation.replyEnabled !== false,
  set: (value) => emit("reply", value)
});
const orchestratorEnabled = computed({
  get: () => props.conversation.orchestratorEnabled !== false,
  set: (value) => emit("orchestrator", value)
});
const scopeLabel = computed(() => {
  if (props.conversation.scope === "private") return "私聊";
  if (props.conversation.scope === "bot_group") return "BOT 群聊";
  return "群聊";
});
const toolsLoading = computed(() => toolPolicy.loading.value || toolPolicy.catalogLoading.value);

watch(
  [() => props.open, () => props.panel, () => props.conversation.id, settingsSection],
  ([open, panel, conversationId, section], previous) => {
    const previousConversationId = previous?.[2];
    if (previousConversationId && previousConversationId !== conversationId) {
      toolPolicy.dispose();
      disabledTools.value = [];
      toolStatus.value = "";
      toolStatusKind.value = "";
      settingsSection.value = "general";
      return;
    }
    if (open && panel === "settings" && section === "tools") void loadTools();
  },
  { immediate: true }
);
onBeforeUnmount(() => toolPolicy.dispose());

async function loadTools(force = false) {
  const conversationId = props.conversation.id;
  toolStatus.value = "";
  toolStatusKind.value = "";
  const loaded = await toolPolicy.load(force);
  if (conversationId !== props.conversation.id) return;
  if (loaded) {
    disabledTools.value = [...toolPolicy.disabledTools.value];
    return;
  }
  toolStatus.value = toolPolicy.error.value || "工具权限读取失败";
  toolStatusKind.value = "error";
}

async function setToolEnabled(name: ToolName, enabled: boolean) {
  if (toolPolicy.saving.value || toolsLoading.value) return;
  const conversationId = props.conversation.id;
  const previous = [...disabledTools.value];
  const next = new Set(previous);
  if (enabled) next.delete(name);
  else next.add(name);
  disabledTools.value = [...next];
  toolStatus.value = "正在生效";
  toolStatusKind.value = "";
  const saved = await toolPolicy.save(disabledTools.value);
  if (conversationId !== props.conversation.id) return;
  if (saved) {
    disabledTools.value = [...toolPolicy.disabledTools.value];
    toolStatus.value = "已生效";
    toolStatusKind.value = "saved";
    return;
  }
  disabledTools.value = previous;
  toolStatus.value = toolPolicy.error.value || "工具权限保存失败";
  toolStatusKind.value = "error";
}
</script>

<template>
  <DialogOverlay :open="open" placement="right" :labelledby="titleId" @close="emit('close')">
    <aside data-slot="conversation-side-panel" class="h-full w-full max-w-xl overflow-y-auto border-l border-visible bg-panel">
      <header data-slot="conversation-side-panel-header" class="sticky top-0 z-10 flex min-h-20 items-center gap-3 border-b border-line bg-panel px-4 md:px-6">
        <button
          data-dialog-initial-focus
          class="icon-btn"
          type="button"
          :aria-label="closeLabel"
          @click="emit('close')"
        >
          <i class="bx bx-left-arrow-alt text-xl" aria-hidden="true"></i>
        </button>
        <h2 :id="titleId" class="text-xl font-medium text-display">{{ title }}</h2>
      </header>

      <template v-if="panel === 'settings'">
        <nav class="segmented mx-4 mt-5 md:mx-6" aria-label="会话设置分区">
          <button class="segmented-button" type="button" :aria-pressed="settingsSection === 'general'" @click="settingsSection = 'general'">回复</button>
          <button class="segmented-button" type="button" :aria-pressed="settingsSection === 'tools'" @click="settingsSection = 'tools'">工具权限</button>
        </nav>

        <div v-if="settingsSection === 'general'" class="grid gap-8 px-4 py-6 md:px-6">
          <section aria-labelledby="conversation-reply-control-title">
          <h3 id="conversation-reply-control-title" class="text-base font-medium text-display">回复控制</h3>
          <div class="mt-3 divide-y divide-line border-y border-line">
            <ToggleSwitch v-model="replyEnabled" class="py-2" label="启动" />
            <ToggleSwitch
              v-if="conversation.scope === 'user_group'"
              v-model="orchestratorEnabled"
              class="py-2"
              label="编排器"
              description="自动判断是否参与群聊"
              :disabled="!replyEnabled"
            />
          </div>
          <ConversationOrchestratorStatus
            v-if="conversation.scope === 'user_group' && replyEnabled && orchestratorEnabled && conversation.orchestratorStatus"
            :status="conversation.orchestratorStatus"
          />
          </section>

          <section aria-labelledby="conversation-information-title">
          <h3 id="conversation-information-title" class="text-base font-medium text-display">会话信息</h3>
          <dl class="mt-3 divide-y divide-line border-y border-line text-sm">
            <div class="flex items-start justify-between gap-6 py-3">
              <dt class="text-mute">类型</dt>
              <dd class="text-right text-display">{{ scopeLabel }}</dd>
            </div>
            <div class="flex items-start justify-between gap-6 py-3">
              <dt class="text-mute">身份</dt>
              <dd class="max-w-[70%] break-words text-right font-mono text-xs text-display">{{ conversationIdentityDetail(conversation) }}</dd>
            </div>
            <div class="flex items-start justify-between gap-6 py-3">
              <dt class="text-mute">消息</dt>
              <dd class="font-mono text-display">{{ conversation.messageCount }}</dd>
            </div>
          </dl>
          </section>
        </div>

        <div v-else class="px-4 py-6 md:px-6">
          <ConversationToolSettingsForm
            :tools="toolPolicy.tools.value"
            :disabled-tools="disabledTools"
            :loading="toolsLoading"
            :busy="toolsLoading || toolPolicy.saving.value"
            @toggle="setToolEnabled"
          />
          <p v-if="toolStatus" class="mt-4 inline-state" :data-kind="toolStatusKind">{{ toolStatus }}</p>
        </div>
      </template>

      <ModelCallStatsPanel
        v-if="panel === 'usage'"
        compact
        :stats="stats?.modelCalls ?? null"
        :messages="stats?.messages"
        :collapsible="false"
      />
    </aside>
  </DialogOverlay>
</template>
