<script setup lang="ts">
import { computed, shallowRef } from "vue";
import { useAgents } from "../../composables/useAgents";
import CreateAgentDialog from "../agents/CreateAgentDialog.vue";
import DeleteAgentDialog from "../agents/DeleteAgentDialog.vue";

const props = defineProps<{ agentId: string; beforeChange: () => Promise<boolean> }>();
const state = useAgents();
const selected = computed(() => state.agents.value.find((agent) => agent.id === props.agentId));
const createOpen = shallowRef(false);
const deleteOpen = shallowRef(false);
const busy = shallowRef(false);
const error = shallowRef("");

async function create(input: Parameters<typeof state.create>[0]) {
  busy.value = true;
  error.value = "";
  try {
    if (!await props.beforeChange()) throw new Error("设置保存失败，请重试后创建 Agent。");
    await state.create(input);
    createOpen.value = false;
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "Agent 创建失败";
  } finally {
    busy.value = false;
  }
}

async function toggleEnabled() {
  const agent = selected.value;
  if (!agent) return;
  busy.value = true;
  error.value = "";
  try {
    if (!await props.beforeChange()) throw new Error("设置保存失败，请重试后操作。");
    await state.update(agent.id, { enabled: !agent.enabled });
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "Agent 状态更新失败";
  } finally {
    busy.value = false;
  }
}

async function removeAgent(confirmation: string) {
  const agent = selected.value;
  if (!agent) return;
  busy.value = true;
  error.value = "";
  try {
    if (!await props.beforeChange()) throw new Error("设置保存失败，请重试后删除 Agent。");
    await state.remove(agent.id, confirmation);
    deleteOpen.value = false;
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "Bot 删除失败";
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <section class="grid gap-6 border-b border-line pb-8" aria-label="Agent 管理">
    <div class="flex flex-wrap items-center justify-between gap-4">
      <div class="flex flex-wrap gap-2" role="group" aria-label="选择 Agent">
        <button v-for="agent in state.agents.value" :key="agent.id" class="btn min-h-10 px-4" :class="agent.id === agentId ? 'btn-primary' : 'btn-ghost'" type="button" :aria-label="`选择 ${agent.name}`" :aria-pressed="agent.id === agentId" :disabled="busy" @click="state.select(agent.id)">{{ agent.name }}</button>
      </div>
      <button class="btn min-h-10 px-4" type="button" :disabled="busy" @click="error = ''; createOpen = true">新增 Agent</button>
    </div>
    <div v-if="selected" class="flex flex-wrap items-center justify-between gap-4">
      <div class="min-w-0">
        <h2 class="section-title break-words">{{ selected.name }}</h2>
        <p class="mt-2 text-sm text-mute">{{ selected.enabled ? '已启用' : '已停用' }} · {{ selected.runtime?.loaded ? '运行时已加载' : '运行时未加载' }} · 记忆 {{ selected.runtime?.persona?.memoryItems ?? 0 }}</p>
      </div>
      <div class="flex flex-wrap gap-2">
        <button class="btn min-h-10 px-4" type="button" :disabled="busy" @click="toggleEnabled">{{ selected.enabled ? '停用' : '启用' }}</button>
        <button v-if="selected.id !== 'plana'" class="btn btn-danger min-h-10 px-4" type="button" :disabled="busy" @click="error = ''; deleteOpen = true">删除 Bot</button>
      </div>
    </div>
    <p v-if="error || state.error.value" class="text-sm text-accent" role="alert">{{ error || state.error.value }}</p>
  </section>
  <CreateAgentDialog :open="createOpen" :busy="busy" :error="error" @close="createOpen = false" @submit="create" />
  <DeleteAgentDialog :open="deleteOpen" :agent="selected" :busy="busy" :error="error" @close="deleteOpen = false" @confirm="removeAgent" />
</template>
