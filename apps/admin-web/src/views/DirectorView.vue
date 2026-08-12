<script setup lang="ts">
import { computed, onBeforeUnmount, shallowRef, watch } from "vue";
import DirectorConversationTargets from "../components/director/DirectorConversationTargets.vue";
import DirectorDecisionList from "../components/director/DirectorDecisionList.vue";
import DirectorPlannedTasks from "../components/director/DirectorPlannedTasks.vue";
import ScheduledTaskPagination from "../components/scheduled-tasks/ScheduledTaskPagination.vue";
import PageHeader from "../components/ui/PageHeader.vue";
import ToggleSwitch from "../components/ui/ToggleSwitch.vue";
import { activeAgentIdState } from "../composables/agentScope";
import { useDirector } from "../composables/useDirector";

type DirectorTab = "decisions" | "tasks" | "conversations";
const agentId = computed(() => activeAgentIdState.value || "plana");
const activeTab = shallowRef<DirectorTab>("decisions");
const director = useDirector();

watch(agentId, (value) => void director.load(value), { immediate: true });
onBeforeUnmount(director.dispose);

const tabs: Array<{ id: DirectorTab; label: string }> = [
  { id: "decisions", label: "每日决策" },
  { id: "tasks", label: "计划任务" },
  { id: "conversations", label: "发送会话" }
];
</script>

<template>
  <div class="page-shell">
    <div class="page-frame">
      <PageHeader title="导演系统">
        <template #actions>
          <span v-if="director.message.value" class="inline-state" :data-kind="director.messageKind.value">{{ director.message.value }}</span>
          <button class="icon-btn" type="button" :disabled="director.busy.value" aria-label="刷新导演系统" @click="director.load(agentId)">
            <i class="bx bx-refresh text-xl" :class="director.loading.value ? 'bx-spin' : ''" aria-hidden="true"></i>
          </button>
        </template>
      </PageHeader>

      <section class="director-switch" aria-label="导演系统状态">
        <ToggleSwitch
          :model-value="director.enabled.value"
          label="导演系统"
          :description="director.enabled.value ? '运行中' : '已关闭'"
          :disabled="director.busy.value"
          @update:model-value="director.setEnabled(agentId, $event)"
        />
      </section>

      <nav class="director-tabs" role="tablist" aria-label="导演系统内容">
        <button
          v-for="tab in tabs"
          :id="`director-tab-${tab.id}`"
          :key="tab.id"
          class="director-tab"
          type="button"
          role="tab"
          :aria-selected="activeTab === tab.id"
          :aria-controls="`director-panel-${tab.id}`"
          @click="activeTab = tab.id"
        >{{ tab.label }}</button>
      </nav>

      <section v-if="activeTab === 'decisions'" id="director-panel-decisions" role="tabpanel" aria-labelledby="director-tab-decisions">
        <DirectorDecisionList :schedules="director.schedules.value" :loading="director.loading.value" />
        <ScheduledTaskPagination
          :page="director.pagination.value.page"
          :page-count="director.pagination.value.pageCount"
          :page-size="director.pagination.value.pageSize"
          :total="director.pagination.value.total"
          :loading="director.loading.value"
          @change="director.changePage(agentId, $event)"
        />
      </section>
      <DirectorPlannedTasks v-else-if="activeTab === 'tasks'" :agent-id="agentId" />
      <DirectorConversationTargets
        v-else
        :conversations="director.conversations.value"
        :saving-ids="director.savingConversationIds.value"
        :loading="director.loading.value"
        @toggle="(conversationId, enabled) => director.setConversationEnabled(agentId, conversationId, enabled)"
      />
    </div>
  </div>
</template>

<style scoped>
.director-switch { border-block: 1px solid rgb(var(--color-line)); padding: 20px 0; }
.director-tabs { display: flex; gap: 4px; margin-top: 32px; overflow-x: auto; border-bottom: 1px solid rgb(var(--color-line)); }
.director-tab { position: relative; min-width: 96px; min-height: 44px; padding: 0 16px; color: rgb(var(--color-mute)); font-size: 14px; font-weight: 500; white-space: nowrap; }
.director-tab::after { position: absolute; right: 12px; bottom: -1px; left: 12px; height: 2px; background: transparent; content: ""; }
.director-tab:hover, .director-tab[aria-selected="true"] { color: rgb(var(--color-display)); }
.director-tab[aria-selected="true"]::after { background: rgb(var(--color-display)); }
.director-tab:focus-visible { outline: 2px solid rgb(var(--color-display)); outline-offset: -2px; }
</style>
