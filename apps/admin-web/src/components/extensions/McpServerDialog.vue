<script setup lang="ts">
import { computed, reactive, watch } from "vue";
import type { AgentMcpServer, McpApprovalMode, McpInstallPreview, McpTransport } from "../../types/agentExtensions";
import DialogOverlay from "../ui/DialogOverlay.vue";

const props = defineProps<{
  open: boolean;
  server: AgentMcpServer | null;
  preview: McpInstallPreview | null;
  busy: boolean;
  error: string;
}>();
const emit = defineEmits<{ close: []; preview: [server: AgentMcpServer]; save: [] }>();
const draft = reactive({
  id: "",
  name: "",
  description: "",
  transport: "stdio" as McpTransport,
  required: false,
  approvalMode: "always" as McpApprovalMode,
  enabledTools: "",
  disabledTools: "",
  ordinaryUserTools: "",
  command: "/usr/bin/",
  args: "",
  envKeys: "",
  url: "https://",
  authKind: "none" as "none" | "bearer" | "oauth",
  credentialRef: ""
});
const editing = computed(() => Boolean(props.server));

watch(() => props.open, (open) => {
  if (!open) return;
  const server = props.server;
  Object.assign(draft, {
    id: server?.id ?? "",
    name: server?.name ?? "",
    description: server?.description ?? "",
    transport: server?.transport ?? "stdio",
    required: server?.required ?? false,
    approvalMode: server?.approvalMode ?? "always",
    enabledTools: server?.enabledTools?.join("\n") ?? "",
    disabledTools: server?.disabledTools?.join("\n") ?? "",
    ordinaryUserTools: server?.ordinaryUserTools?.join("\n") ?? "",
    command: server?.transport === "stdio" ? server.command : "/usr/bin/",
    args: server?.transport === "stdio" ? server.args.join("\n") : "",
    envKeys: server?.transport === "stdio" ? server.envKeys.join("\n") : "",
    url: server?.transport === "streamable_http" ? server.url : "https://",
    authKind: server?.transport === "streamable_http" ? server.auth.kind : "none",
    credentialRef: server?.transport === "streamable_http" && server.auth.kind !== "none" ? server.auth.credentialRef : ""
  });
});

function lines(value: string) {
  return [...new Set(value.split(/\r?\n/u).map((item) => item.trim()).filter(Boolean))];
}

function buildServer(): AgentMcpServer {
  const policy = {
    id: draft.id.trim(),
    name: draft.name.trim(),
    description: draft.description.trim(),
    enabled: false,
    required: draft.required,
    enabledTools: lines(draft.enabledTools),
    disabledTools: lines(draft.disabledTools),
    ...(lines(draft.ordinaryUserTools).length ? { ordinaryUserTools: lines(draft.ordinaryUserTools) } : {}),
    approvalMode: draft.approvalMode
  };
  if (draft.transport === "stdio") {
    return { ...policy, transport: "stdio", command: draft.command.trim(), args: lines(draft.args), envKeys: lines(draft.envKeys) };
  }
  const auth = draft.authKind === "none"
    ? { kind: "none" as const }
    : { kind: draft.authKind, credentialRef: draft.authKind === "oauth" ? (draft.credentialRef.trim() || "pending") : draft.credentialRef.trim() };
  return { ...policy, transport: "streamable_http", url: draft.url.trim(), auth };
}
</script>

<template>
  <DialogOverlay :open="open" placement="right" labelledby="mcp-server-title" @close="emit('close')">
    <form class="h-full w-full max-w-2xl overflow-y-auto border-l border-visible bg-panel p-6 md:p-8" @submit.prevent="preview ? emit('save') : emit('preview', buildServer())">
      <header class="flex items-start justify-between gap-4 border-b border-line pb-6">
        <div><p class="meta-label">Server Descriptor</p><h2 id="mcp-server-title" class="mt-2 text-2xl font-medium text-display">{{ editing ? "编辑 MCP" : "添加 MCP" }}</h2></div>
        <button class="icon-btn" type="button" aria-label="关闭" @click="emit('close')"><i class="bx bx-x" aria-hidden="true"></i></button>
      </header>
      <div class="mt-6 grid gap-5 sm:grid-cols-2">
        <label class="field"><span class="field-label">服务 ID</span><input v-model="draft.id" class="control" pattern="[a-z0-9]+(?:-[a-z0-9]+)*" maxlength="64" required :disabled="editing || Boolean(preview)" data-dialog-initial-focus></label>
        <label class="field"><span class="field-label">名称</span><input v-model="draft.name" class="control" maxlength="128" required :disabled="Boolean(preview)"></label>
        <label class="field sm:col-span-2"><span class="field-label">描述</span><textarea v-model="draft.description" class="control min-h-20" maxlength="1024" :disabled="Boolean(preview)"></textarea></label>
        <label class="field"><span class="field-label">传输</span><select v-model="draft.transport" class="control" :disabled="Boolean(preview)"><option value="stdio">本地 stdio</option><option value="streamable_http">远端 HTTP</option></select></label>
        <label class="field"><span class="field-label">审批</span><select v-model="draft.approvalMode" class="control" :disabled="Boolean(preview)"><option value="always">每次</option><option value="mutating">变更操作</option><option value="never">无需审批</option></select></label>
      </div>
      <label class="mt-5 flex min-h-11 items-center gap-3 text-sm"><input v-model="draft.required" class="size-4 accent-current" type="checkbox" :disabled="Boolean(preview)"><span>作为 Agent 必需服务</span></label>

      <section class="mt-6 border-t border-line pt-6">
        <h3 class="meta-label">工具策略</h3>
        <div class="mt-4 grid gap-5 sm:grid-cols-3">
          <label class="field"><span class="field-label">允许工具</span><textarea v-model="draft.enabledTools" class="control min-h-24" placeholder="每行一个，留空则关闭所有工具" :disabled="Boolean(preview)"></textarea></label>
          <label class="field"><span class="field-label">禁用工具</span><textarea v-model="draft.disabledTools" class="control min-h-24" placeholder="每行一个" :disabled="Boolean(preview)"></textarea></label>
          <label class="field"><span class="field-label">普通用户工具</span><textarea v-model="draft.ordinaryUserTools" class="control min-h-24" placeholder="仅无凭据服务" :disabled="Boolean(preview)"></textarea></label>
        </div>
      </section>

      <section class="mt-6 border-t border-line pt-6">
        <template v-if="draft.transport === 'stdio'">
          <h3 class="meta-label">完整启动命令</h3>
          <label class="field mt-4"><span class="field-label">可执行文件</span><input v-model="draft.command" class="control" placeholder="/usr/bin/server" required :disabled="Boolean(preview)"></label>
          <div class="mt-5 grid gap-5 sm:grid-cols-2">
            <label class="field"><span class="field-label">参数</span><textarea v-model="draft.args" class="control min-h-28" placeholder="每行一个参数" :disabled="Boolean(preview)"></textarea></label>
            <label class="field"><span class="field-label">环境变量名称</span><textarea v-model="draft.envKeys" class="control min-h-28" placeholder="每行一个名称，不填写值" :disabled="Boolean(preview)"></textarea></label>
          </div>
        </template>
        <template v-else>
          <h3 class="meta-label">远端连接</h3>
          <label class="field mt-4"><span class="field-label">URL</span><input v-model="draft.url" class="control" type="url" required :disabled="Boolean(preview)"></label>
          <div class="mt-5 grid gap-5 sm:grid-cols-2">
            <label class="field"><span class="field-label">认证</span><select v-model="draft.authKind" class="control" :disabled="Boolean(preview)"><option value="none">无</option><option value="bearer">Bearer 引用</option><option value="oauth">OAuth</option></select></label>
            <label v-if="draft.authKind === 'bearer'" class="field"><span class="field-label">凭据引用</span><input v-model="draft.credentialRef" class="control" placeholder="service/token" required :disabled="Boolean(preview)"></label>
          </div>
        </template>
      </section>

      <section v-if="preview" class="mt-6 border-y border-visible py-5" aria-label="MCP 安装预览">
        <p class="meta-label">确认配置</p>
        <template v-if="preview.commandApproval">
          <code class="mt-4 block break-all border-l-2 border-accent pl-4 font-mono text-xs leading-6 text-display">{{ [preview.commandApproval.command, ...preview.commandApproval.args].join(" ") }}</code>
          <p class="mt-3 text-xs text-mute">保存即确认运行以上完整命令。</p>
        </template>
        <p v-else class="mt-4 break-all font-mono text-xs text-display">{{ preview.server.transport === "streamable_http" ? preview.server.url : preview.server.id }}</p>
      </section>
      <p v-if="error" class="mt-5 text-sm text-accent" role="alert">{{ error }}</p>
      <footer class="sticky bottom-0 mt-8 flex justify-end gap-2 border-t border-line bg-panel py-4 pb-[calc(16px+env(safe-area-inset-bottom))]">
        <button class="btn" type="button" @click="emit('close')">取消</button>
        <button class="btn btn-primary" type="submit" :disabled="busy">{{ busy ? "处理中" : preview ? "确认保存" : "生成预览" }}</button>
      </footer>
    </form>
  </DialogOverlay>
</template>
