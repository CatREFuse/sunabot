<script setup lang="ts">
import { computed, reactive, watch } from "vue";
import type { AgentMcpHttpServer } from "../../types/agentExtensions";
import DialogOverlay from "../ui/DialogOverlay.vue";

const props = defineProps<{
  server: AgentMcpHttpServer | null;
  agentId: string;
  agentName: string;
  authorizationOrigin: string;
  busy: boolean;
  error: string;
}>();
const emit = defineEmits<{
  close: [];
  begin: [input: { authorizationEndpoint: string; tokenEndpoint: string; clientId: string; scopes: string[] }];
  refresh: [];
  revoke: [];
}>();
const draft = reactive({ authorizationEndpoint: "https://", tokenEndpoint: "https://", clientId: "", scopes: "" });
const connected = computed(() => Boolean(props.server?.auth.kind === "oauth" && /^mcpcred_/.test(props.server.auth.credentialRef)));

watch(() => props.server, () => Object.assign(draft, {
  authorizationEndpoint: "https://",
  tokenEndpoint: "https://",
  clientId: "",
  scopes: ""
}));

function submit() {
  emit("begin", {
    authorizationEndpoint: draft.authorizationEndpoint.trim(),
    tokenEndpoint: draft.tokenEndpoint.trim(),
    clientId: draft.clientId.trim(),
    scopes: [...new Set(draft.scopes.split(/[\s,]+/u).map((value) => value.trim()).filter(Boolean))]
  });
}
</script>

<template>
  <DialogOverlay :open="Boolean(server)" labelledby="mcp-oauth-title" @close="emit('close')">
    <form v-if="server" class="flex max-h-[calc(100dvh-2rem)] w-full max-w-xl flex-col overflow-hidden rounded border border-visible bg-panel" @submit.prevent="submit">
      <header class="flex shrink-0 items-start justify-between gap-4 border-b border-line px-5 py-5 md:px-8 md:py-6">
        <div class="min-w-0"><p class="meta-label">OAuth 2.1</p><h2 id="mcp-oauth-title" class="mt-2 truncate text-2xl font-medium text-display">{{ server.name }}</h2></div>
        <button class="icon-btn" type="button" aria-label="关闭" @click="emit('close')"><i class="bx bx-x" aria-hidden="true"></i></button>
      </header>
      <div data-slot="dialog-scroll" class="min-h-0 flex-1 overflow-y-auto px-5 py-6 md:px-8">
        <dl class="border-y border-line" aria-label="OAuth 授权目标">
          <div class="grid gap-1 border-b border-line py-3 sm:grid-cols-[7.5rem_minmax(0,1fr)] sm:gap-4"><dt class="meta-label">当前 Agent</dt><dd class="min-w-0 break-words text-sm text-ink">{{ agentName }} <span class="font-mono text-xs text-mute">{{ agentId }}</span></dd></div>
          <div class="grid gap-1 border-b border-line py-3 sm:grid-cols-[7.5rem_minmax(0,1fr)] sm:gap-4"><dt class="meta-label">Server ID</dt><dd class="min-w-0 break-all font-mono text-xs text-ink">{{ server.id }}</dd></div>
          <div class="grid gap-1 border-b border-line py-3 sm:grid-cols-[7.5rem_minmax(0,1fr)] sm:gap-4"><dt class="meta-label">Resource URL</dt><dd class="min-w-0 break-all font-mono text-xs text-ink">{{ server.url }}</dd></div>
          <div class="grid gap-1 py-3 sm:grid-cols-[7.5rem_minmax(0,1fr)] sm:gap-4"><dt class="meta-label">授权来源</dt><dd class="min-w-0 break-all font-mono text-xs text-ink">{{ authorizationOrigin || "启动后确认" }}</dd></div>
        </dl>
        <template v-if="connected">
          <p class="mt-6 inline-state" data-kind="success" role="status">已连接</p>
          <p class="mt-2 text-sm leading-6 text-mute">凭据已绑定当前 Agent 与服务地址。</p>
        </template>
        <template v-else>
          <div class="mt-6 grid gap-5">
          <label class="field"><span class="field-label">授权端点</span><input v-model="draft.authorizationEndpoint" class="control" type="url" required data-dialog-initial-focus></label>
          <label class="field"><span class="field-label">Token 端点</span><input v-model="draft.tokenEndpoint" class="control" type="url" required></label>
          <label class="field"><span class="field-label">Client ID</span><input v-model="draft.clientId" class="control" maxlength="256" required></label>
          <label class="field"><span class="field-label">Scopes</span><input v-model="draft.scopes" class="control" placeholder="tools resources"></label>
          </div>
          <p class="mt-5 text-xs leading-5 text-mute">将打开授权服务，回调仅监听本机临时端口。</p>
        </template>
      </div>
      <footer data-slot="dialog-actions" class="shrink-0 border-t border-line px-5 py-4 md:px-8">
        <p v-if="error" class="mb-3 text-sm text-accent" role="alert">{{ error }}</p>
        <div v-if="connected" class="flex flex-wrap justify-end gap-2"><button class="btn" type="button" :disabled="busy" @click="emit('refresh')">刷新凭据</button><button class="btn btn-danger" type="button" :disabled="busy" @click="emit('revoke')">撤销授权</button></div>
        <div v-else class="flex flex-wrap justify-end gap-2"><button class="btn" type="button" @click="emit('close')">取消</button><button class="btn btn-primary" type="submit" :disabled="busy">{{ busy ? "启动中" : "打开授权" }}</button></div>
      </footer>
    </form>
  </DialogOverlay>
</template>
