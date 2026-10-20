<script setup lang="ts">
import { computed, onBeforeUnmount, shallowRef, watch } from "vue";
import type { NapcatConnectionInfo } from "../../../../../packages/contracts/admin/public";
import type { AgentSummary, OneBotLoginCheck } from "../../types";
import { apiRequest } from "../../composables/useAdminApi";
import AgentAccountList from "../agents/AgentAccountList.vue";

const props = defineProps<{ agentId: string }>();
const agent = shallowRef<AgentSummary>();
const connection = shallowRef<NapcatConnectionInfo>();
const loginStates = shallowRef<Record<string, OneBotLoginCheck>>({});
const error = shallowRef("");
const busy = shallowRef(false);
const pendingAction = shallowRef<{ kind: "create" } | { kind: "remove"; accountId: string }>();
const onebotUrl = computed(() => {
  if (!connection.value) return "";
  const url = new URL(connection.value.onebotUrl);
  const account = agent.value?.accounts[0];
  if (account) url.searchParams.set("account_id", account.id);
  return url.toString();
});
let controller: AbortController | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;
let generation = 0;

async function refresh() {
  const current = ++generation;
  controller?.abort();
  clearTimeout(timer);
  controller = new AbortController();
  const signal = controller.signal;
  const agentId = props.agentId;
  try {
    const [catalog, info] = await Promise.all([
      apiRequest<{ agents: AgentSummary[] }>("/api/agents", { signal }),
      apiRequest<NapcatConnectionInfo>(`/api/agents/${encodeURIComponent(agentId)}/connection`, { signal })
    ]);
    const selected = catalog.agents.find((item) => item.id === agentId);
    if (!selected) throw new Error("Agent 不存在");
    if (current !== generation) return;
    agent.value = selected;
    connection.value = info;
    const statuses = await Promise.all(selected.accounts.map(async (account) => [
      account.id,
      await apiRequest<OneBotLoginCheck>(`/api/agents/${encodeURIComponent(agentId)}/accounts/${encodeURIComponent(account.id)}/login/status`, { signal })
    ] as const));
    if (current !== generation) return;
    loginStates.value = Object.fromEntries(statuses);
    error.value = "";
  } catch (cause) {
    if (current !== generation) return;
    loginStates.value = {};
    error.value = cause instanceof Error ? cause.message : "连接状态读取失败";
  } finally {
    if (current === generation) timer = setTimeout(() => void refresh(), 10_000);
  }
}

watch(() => props.agentId, () => {
  agent.value = undefined;
  connection.value = undefined;
  loginStates.value = {};
  error.value = "";
  void refresh();
}, { immediate: true });
onBeforeUnmount(() => {
  generation += 1;
  controller?.abort();
  clearTimeout(timer);
});

async function act(kind: "create" | "run" | "remove", value: string) {
  const agentId = props.agentId;
  const base = `/api/agents/${encodeURIComponent(agentId)}/accounts`;
  busy.value = true;
  error.value = "";
  pendingAction.value = kind === "create" ? { kind } : kind === "remove" ? { kind, accountId: value } : undefined;
  try {
    await apiRequest(kind === "create" ? base : `${base}/${encodeURIComponent(value)}${kind === "run" ? "/runtime/start" : ""}`, {
      method: kind === "remove" ? "DELETE" : "POST",
      ...(kind === "create" ? { body: JSON.stringify({ label: value }) } : {})
    });
    if (agentId === props.agentId) await refresh();
  } catch (cause) {
    if (agentId === props.agentId) error.value = cause instanceof Error ? cause.message : "账号操作失败";
  } finally {
    busy.value = false;
    pendingAction.value = undefined;
  }
}
</script>

<template>
  <section class="min-w-0">
    <div class="flex items-center justify-between gap-4">
      <h2 class="section-title">QQ 接入</h2>
      <button class="btn" type="button" @click="refresh">刷新状态</button>
    </div>
    <p v-if="error" class="mt-4 text-sm text-accent" role="alert">{{ error }}</p>
    <dl v-if="connection" class="mt-6 grid min-w-0 gap-x-8 sm:grid-cols-2">
      <div class="border-b border-line py-4"><dt class="meta-label">运行方式</dt><dd class="mt-2">{{ connection.mode === "remote" ? "远程托管" : "本地自启动" }}</dd></div>
      <div class="min-w-0 border-b border-line py-4"><dt class="meta-label">NapCat 位置</dt><dd class="mt-2 break-all font-mono text-sm">{{ connection.host }}</dd></div>
      <div class="border-b border-line py-4"><dt class="meta-label">连接方式</dt><dd class="mt-2">{{ connection.transport === "ssh" ? "SSH 隧道" : "本地连接" }}</dd></div>
      <div class="border-b border-line py-4"><dt class="meta-label">OneBot 端口</dt><dd class="mt-2 font-mono text-sm">{{ connection.onebotPort }}</dd></div>
      <div class="min-w-0 border-b border-line py-4 sm:col-span-2"><dt class="meta-label">OneBot 反向 WebSocket</dt><dd class="mt-2 break-all font-mono text-sm">{{ onebotUrl }}</dd></div>
      <div v-if="connection.mode === 'remote'" class="min-w-0 border-b border-line py-4 sm:col-span-2"><dt class="meta-label">Core 监听地址</dt><dd class="mt-2 break-all font-mono text-sm">{{ connection.coreUrl }}</dd></div>
    </dl>
    <p v-else-if="!error" class="mt-6 text-sm text-mute" role="status">正在读取连接信息</p>
    <AgentAccountList
      v-if="agent"
      :key="agent.id"
      :agent-id="agent.id"
      :accounts="agent.accounts"
      :agent-enabled="agent.enabled"
      :login-states="loginStates"
      :busy="busy"
      :pending-action="pendingAction"
      @create="act('create', $event)"
      @run="act('run', $event)"
      @remove="act('remove', $event)"
      @refresh="refresh"
    />
  </section>
</template>
