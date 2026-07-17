<script setup lang="ts">
import { computed } from "vue";
import type { AgentExtensionOverview, AgentMcpServer, McpRuntimeServerStatus } from "../../types/agentExtensions";

type McpSecretStatus = AgentExtensionOverview["mcp"]["secrets"];
type SecretEntry = { key: string; status: "configured" | "missing" };

const DERIVED_MCP_ENV_KEY = /^SUNABOT_MCP_(?:STDIO_SECRET|HTTP_BEARER)_[A-F0-9]{32}$/u;

const props = defineProps<{
  servers: readonly AgentMcpServer[];
  statuses: readonly McpRuntimeServerStatus[];
  secrets?: McpSecretStatus;
  busy: boolean;
}>();
const emit = defineEmits<{
  edit: [server: AgentMcpServer];
  detail: [server: AgentMcpServer];
  toggle: [server: AgentMcpServer];
  oauth: [server: AgentMcpServer];
  remove: [server: AgentMcpServer];
}>();

const secretEntries = computed<SecretEntry[]>(() => {
  const entries = new Map<string, SecretEntry["status"]>();
  for (const key of props.secrets?.configuredKeys ?? []) {
    if (DERIVED_MCP_ENV_KEY.test(key)) entries.set(key, "configured");
  }
  for (const key of props.secrets?.missingKeys ?? []) {
    if (DERIVED_MCP_ENV_KEY.test(key)) entries.set(key, "missing");
  }
  return [...entries]
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, status]) => ({ key, status }));
});

function status(server: AgentMcpServer) {
  return props.statuses.find((item) => item.serverId === server.id);
}

function statusLabel(server: AgentMcpServer) {
  if (!server.enabled) return "已停用";
  const current = status(server);
  if (current?.status === "ready" && current.toolCatalogStatus === "ready") return "就绪";
  if (current?.status === "unavailable") return "不可用";
  return "降级";
}

function statusKind(server: AgentMcpServer) {
  const label = statusLabel(server);
  return label === "就绪" ? "success" : label === "已停用" ? undefined : label === "不可用" ? "error" : "warning";
}

function oauthReady(server: AgentMcpServer) {
  return server.transport === "streamable_http" && server.auth.kind === "oauth" && /^mcpcred_/.test(server.auth.credentialRef);
}

function toolPolicyLabel(server: AgentMcpServer) {
  if (server.enabledTools === undefined) return "未限制";
  return server.enabledTools.length ? `${server.enabledTools.length} 项` : "无可用项";
}

function credentialRequirement(server: AgentMcpServer) {
  if (server.transport === "stdio") {
    return server.envKeys.length ? `环境变量 ${server.envKeys.length} 项` : "无环境变量";
  }
  if (server.auth.kind === "none") return "无凭据";
  if (server.auth.kind === "bearer") return "Bearer 凭据";
  return oauthReady(server) ? "OAuth 已绑定" : "OAuth 待绑定";
}
</script>

<template>
  <section aria-labelledby="mcp-list-title">
    <header class="flex min-h-16 flex-wrap items-center justify-between gap-4 border-b border-visible">
      <div><p class="meta-label">Model Context Protocol</p><h2 id="mcp-list-title" class="mt-2 text-2xl font-medium text-display">MCP 服务</h2></div>
      <slot name="actions" />
    </header>
    <section v-if="secretEntries.length" class="border-b border-visible py-5" aria-labelledby="mcp-secret-status-title">
      <h3 id="mcp-secret-status-title" class="meta-label">环境变量</h3>
      <ul class="mt-3 divide-y divide-line border-t border-line">
        <li v-for="entry in secretEntries" :key="entry.key" class="flex min-h-11 flex-wrap items-center justify-between gap-3 py-2">
          <code class="min-w-0 break-all font-mono text-[10px] text-ink">{{ entry.key }}</code>
          <span class="inline-state" :data-kind="entry.status === 'configured' ? 'success' : 'warning'">{{ entry.status === "configured" ? "已配置" : "缺失" }}</span>
        </li>
      </ul>
    </section>
    <article v-for="server in servers" :key="server.id" class="grid gap-5 border-b border-line py-6 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center">
      <button class="min-w-0 bg-transparent text-left" type="button" :aria-label="`查看 ${server.name} 目录`" @click="emit('detail', server)">
        <span class="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
          <strong class="truncate text-lg font-medium text-display">{{ server.name }}</strong>
          <span class="inline-state" :data-kind="statusKind(server)">{{ statusLabel(server) }}</span>
          <span v-if="server.required" class="inline-state">必需</span>
        </span>
        <span class="mt-3 block max-w-3xl text-sm leading-6 text-mute">{{ server.description || "暂无描述" }}</span>
        <span class="mt-4 flex flex-wrap gap-x-5 gap-y-2 font-mono text-[10px] uppercase tracking-[0.04em] text-mute">
          <span>{{ server.transport === "stdio" ? "STDIO" : "HTTP" }}</span>
          <span>审批 {{ server.approvalMode ?? "always" }}</span>
          <span>工具 {{ toolPolicyLabel(server) }}</span>
          <span>凭据 {{ credentialRequirement(server) }}</span>
          <span v-if="status(server)?.errorCode" class="text-accent">{{ status(server)?.errorCode }}</span>
        </span>
      </button>
      <div class="flex flex-wrap items-center gap-2 lg:justify-end">
        <button v-if="server.transport === 'streamable_http' && server.auth.kind === 'oauth'" class="btn btn-ghost" type="button" :disabled="busy" @click="emit('oauth', server)">{{ oauthReady(server) ? "OAuth" : "连接 OAuth" }}</button>
        <button class="btn btn-ghost" type="button" :disabled="busy" @click="emit('edit', server)">编辑</button>
        <button class="btn" type="button" :disabled="busy" @click="emit('toggle', server)">{{ server.enabled ? "停用" : "启用" }}</button>
        <button class="icon-btn text-accent" type="button" :disabled="busy" :aria-label="`删除 ${server.name}`" @click="emit('remove', server)"><i class="bx bx-trash" aria-hidden="true"></i></button>
      </div>
    </article>
    <div v-if="!servers.length" class="empty-state"><div><strong>没有 MCP 服务</strong><p>添加本地 stdio 或远端 HTTP 服务</p></div></div>
  </section>
</template>
