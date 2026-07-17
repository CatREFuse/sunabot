<script setup lang="ts">
import type { AgentMcpServer, McpCatalogSnapshot, McpRuntimeServerStatus } from "../../types/agentExtensions";
import DialogOverlay from "../ui/DialogOverlay.vue";

defineProps<{
  server: AgentMcpServer | null;
  status?: McpRuntimeServerStatus;
  catalog: McpCatalogSnapshot | null;
  loading: boolean;
  error: string;
}>();
const emit = defineEmits<{ close: []; reload: [] }>();

function identity(item: Record<string, unknown>, key: "name" | "uri" | "uriTemplate") {
  return typeof item[key] === "string" ? item[key] : "未命名";
}
</script>

<template>
  <DialogOverlay :open="Boolean(server)" placement="right" labelledby="mcp-detail-title" @close="emit('close')">
    <section v-if="server" class="h-full w-full max-w-2xl overflow-y-auto border-l border-visible bg-panel p-6 md:p-8">
      <header class="flex items-start justify-between gap-4 border-b border-line pb-6">
        <div class="min-w-0"><p class="meta-label">Runtime Catalog</p><h2 id="mcp-detail-title" class="mt-2 truncate text-2xl font-medium text-display">{{ server.name }}</h2><p class="mt-3 text-sm text-mute">{{ server.id }} · {{ server.transport === "stdio" ? "STDIO" : "HTTP" }}</p></div>
        <button class="icon-btn" type="button" aria-label="关闭" @click="emit('close')"><i class="bx bx-x" aria-hidden="true"></i></button>
      </header>
      <dl class="grid border-b border-line sm:grid-cols-3">
        <div class="py-5 sm:border-r sm:border-line"><dt class="meta-label">服务</dt><dd class="mt-3">{{ status?.status ?? (server.enabled ? "等待" : "已停用") }}</dd></div>
        <div class="border-t border-line py-5 sm:border-r sm:border-t-0 sm:border-line sm:px-5"><dt class="meta-label">目录</dt><dd class="mt-3">{{ status?.toolCatalogStatus ?? "--" }}</dd></div>
        <div class="border-t border-line py-5 sm:border-t-0 sm:pl-5"><dt class="meta-label">刷新</dt><dd class="mt-3 font-mono text-xs">{{ catalog?.refreshedAt ? new Date(catalog.refreshedAt).toLocaleString() : "--" }}</dd></div>
      </dl>
      <div class="mt-6 flex items-center justify-between gap-4"><p class="meta-label">目录快照</p><button class="btn btn-ghost" type="button" :disabled="loading || !server.enabled" @click="emit('reload')">{{ loading ? "读取中" : "刷新" }}</button></div>
      <p v-if="error" class="mt-4 text-sm text-accent" role="alert">{{ error }}</p>
      <div v-if="catalog" class="mt-4 divide-y divide-line border-t border-visible">
        <details class="group" open><summary class="flex min-h-11 items-center justify-between gap-4"><span>工具</span><span class="font-display text-2xl">{{ catalog.tools.length }}</span></summary><ul class="border-t border-line py-2"><li v-for="item in catalog.tools" :key="identity(item, 'name')" class="py-2 font-mono text-xs text-mute">{{ identity(item, "name") }}</li></ul></details>
        <details class="group"><summary class="flex min-h-11 items-center justify-between gap-4"><span>资源</span><span class="font-display text-2xl">{{ catalog.resources.length }}</span></summary><ul class="border-t border-line py-2"><li v-for="item in catalog.resources" :key="identity(item, 'uri')" class="break-all py-2 font-mono text-xs text-mute">{{ identity(item, "uri") }}</li></ul></details>
        <details class="group"><summary class="flex min-h-11 items-center justify-between gap-4"><span>资源模板</span><span class="font-display text-2xl">{{ catalog.resourceTemplates.length }}</span></summary><ul class="border-t border-line py-2"><li v-for="item in catalog.resourceTemplates" :key="identity(item, 'uriTemplate')" class="break-all py-2 font-mono text-xs text-mute">{{ identity(item, "uriTemplate") }}</li></ul></details>
        <details class="group"><summary class="flex min-h-11 items-center justify-between gap-4"><span>Prompts</span><span class="font-display text-2xl">{{ catalog.prompts.length }}</span></summary><ul class="border-t border-line py-2"><li v-for="item in catalog.prompts" :key="identity(item, 'name')" class="py-2 font-mono text-xs text-mute">{{ identity(item, "name") }}</li></ul></details>
      </div>
      <div v-else-if="!loading" class="empty-state"><div><strong>{{ server.enabled ? "目录尚未就绪" : "服务已停用" }}</strong><p>{{ status?.errorCode || "启用服务后读取目录" }}</p></div></div>
    </section>
  </DialogOverlay>
</template>
