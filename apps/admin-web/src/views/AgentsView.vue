<script setup lang="ts">
import { computed, onMounted, shallowRef } from "vue";
import { useRouter } from "vue-router";
import AgentAccountList from "../components/agents/AgentAccountList.vue";
import AgentDirectory from "../components/agents/AgentDirectory.vue";
import CreateAgentDialog from "../components/agents/CreateAgentDialog.vue";
import DeleteAgentDialog from "../components/agents/DeleteAgentDialog.vue";
import IdentityAvatar from "../components/ui/IdentityAvatar.vue";
import PageHeader from "../components/ui/PageHeader.vue";
import { useAgents } from "../composables/useAgents";
import { agentAvatarUrl } from "../utils/agentIdentity";

const state = useAgents();
const router = useRouter();
const createOpen = shallowRef(false);
const deleteOpen = shallowRef(false);
const busy = shallowRef(false);
const accountAction = shallowRef<{ kind: "create" } | { kind: "remove"; accountId: string }>();
const error = shallowRef("");
const selectedId = shallowRef("");
const selected = computed(() => state.agents.value.find((agent) => agent.id === selectedId.value) ?? state.currentAgent.value);

onMounted(async () => {
  await state.load().catch(() => undefined);
  selectedId.value = state.currentAgent.value?.id ?? "";
});

function select(agentId: string) {
  selectedId.value = agentId;
  state.select(agentId);
}

async function create(input: Parameters<typeof state.create>[0]) {
  busy.value = true;
  error.value = "";
  try {
    const agent = await state.create(input);
    selectedId.value = agent.id;
    createOpen.value = false;
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "Agent 创建失败";
  } finally {
    busy.value = false;
  }
}

async function toggleEnabled() {
  if (!selected.value) return;
  busy.value = true;
  try {
    await state.update(selected.value.id, { enabled: !selected.value.enabled });
  } finally {
    busy.value = false;
  }
}

async function removeAgent(confirmation: string) {
  if (!selected.value) return;
  busy.value = true;
  error.value = "";
  try {
    await state.remove(selected.value.id, confirmation);
    deleteOpen.value = false;
    selectedId.value = state.currentAgent.value?.id ?? "";
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "Bot 删除失败";
  } finally {
    busy.value = false;
  }
}

async function createAccount(label: string) {
  if (!selected.value) return;
  busy.value = true;
  accountAction.value = { kind: "create" };
  try {
    await state.createAccount(selected.value.id, label);
  } finally {
    accountAction.value = undefined;
    busy.value = false;
  }
}

async function runAccount(accountId: string) {
  if (!selected.value) return;
  busy.value = true;
  error.value = "";
  try {
    await state.startAccountRuntime(selected.value.id, accountId);
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "QQ 运行容器启动失败";
  } finally {
    busy.value = false;
  }
}

async function removeAccount(accountId: string) {
  if (!selected.value) return;
  busy.value = true;
  accountAction.value = { kind: "remove", accountId };
  try {
    await state.removeAccount(selected.value.id, accountId);
  } finally {
    accountAction.value = undefined;
    busy.value = false;
  }
}
</script>

<template>
  <div class="page-shell">
    <div class="page-frame">
      <PageHeader eyebrow="Identity" title="Agent" />
      <p v-if="state.error.value || error" class="mt-5 text-sm text-accent" role="alert">{{ state.error.value || error }}</p>

      <div class="mt-8 grid border-t border-line lg:grid-cols-[320px_minmax(0,1fr)]">
        <AgentDirectory :agents="state.agents.value" :selected-id="selected?.id" @select="select" @create="createOpen = true" />

        <section v-if="selected" class="min-w-0 px-1 py-8 lg:px-10">
          <div class="flex flex-col gap-6 border-b border-line pb-8 sm:flex-row sm:items-center">
            <IdentityAvatar :src="agentAvatarUrl(selected)" :name="selected.name" size="lg" />
            <div class="min-w-0 flex-1">
              <h2 class="truncate text-3xl font-medium tracking-[-0.02em] text-display">{{ selected.name }}</h2>
              <p class="mt-2 font-mono text-xs text-mute">{{ selected.id }} · {{ selected.workspace }}</p>
            </div>
            <div class="flex flex-wrap gap-3">
              <button class="btn min-h-10 px-4" type="button" :disabled="busy" @click="toggleEnabled">{{ selected.enabled ? "停用" : "启用" }}</button>
              <button v-if="selected.id !== 'plana'" class="btn btn-danger min-h-10 px-4" type="button" :disabled="busy" @click="deleteOpen = true">删除 Bot</button>
            </div>
          </div>

          <dl class="grid border-b border-line sm:grid-cols-3">
            <div class="py-6 sm:border-r sm:border-line sm:px-5 sm:first:pl-0">
              <dt class="meta-label">运行时</dt>
              <dd class="mt-3 text-lg text-display">{{ selected.runtime?.loaded ? "已加载" : "未加载" }}</dd>
            </div>
            <div class="border-t border-line py-6 sm:border-r sm:border-t-0 sm:px-5">
              <dt class="meta-label">在线账号</dt>
              <dd class="mt-3 text-lg text-display">{{ selected.accounts.filter((item) => item.connected).length }} / {{ selected.accounts.length }}</dd>
            </div>
            <div class="border-t border-line py-6 sm:border-t-0 sm:pl-5">
              <dt class="meta-label">记忆</dt>
              <dd class="mt-3 text-lg text-display">{{ selected.runtime?.persona?.memoryItems ?? 0 }}</dd>
            </div>
          </dl>

          <AgentAccountList :agent-id="selected.id" :accounts="selected.accounts" :busy="busy" :pending-action="accountAction" @create="createAccount" @run="runAccount" @remove="removeAccount" @refresh="state.load({ force: true })" />

          <section class="mt-10 border-t border-line pt-6">
            <span class="meta-label">工作区</span>
            <div class="mt-4 grid sm:grid-cols-2">
              <button class="divider-row bg-transparent text-left sm:mr-6" type="button" @click="router.push('/agent-prompts')"><span>Agent 提示词</span><i class="bx bx-right-arrow-alt text-xl" aria-hidden="true"></i></button>
              <button class="divider-row bg-transparent text-left" type="button" @click="router.push('/memory')"><span>记忆</span><i class="bx bx-right-arrow-alt text-xl" aria-hidden="true"></i></button>
              <button class="divider-row bg-transparent text-left sm:mr-6" type="button" @click="router.push('/images')"><span>图像</span><i class="bx bx-right-arrow-alt text-xl" aria-hidden="true"></i></button>
              <button class="divider-row bg-transparent text-left" type="button" @click="router.push('/agent-settings')"><span>Agent 设置</span><i class="bx bx-right-arrow-alt text-xl" aria-hidden="true"></i></button>
            </div>
          </section>
        </section>
      </div>
    </div>
  </div>

  <CreateAgentDialog :open="createOpen" :busy="busy" :error="error" @close="createOpen = false" @submit="create" />
  <DeleteAgentDialog :open="deleteOpen" :agent="selected" :busy="busy" :error="error" @close="deleteOpen = false" @confirm="removeAgent" />
</template>
