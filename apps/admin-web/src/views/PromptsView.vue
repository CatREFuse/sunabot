<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, shallowRef, watch } from "vue";
import { onBeforeRouteLeave, onBeforeRouteUpdate, useRoute, useRouter, type RouteLocationNormalized } from "vue-router";
import { ApiRequestError } from "../composables/useAdminApi";
import { usePromptLibrary } from "../composables/usePromptLibrary";
import PromptEditor from "../components/prompts/PromptEditor.vue";
import PromptFileList from "../components/prompts/PromptFileList.vue";
import AgentSoulControls from "../components/prompts/AgentSoulControls.vue";
import DialogOverlay from "../components/ui/DialogOverlay.vue";
import ToggleSwitch from "../components/ui/ToggleSwitch.vue";
import type { AgentFileDetail } from "../types";
import { apiRequest } from "../composables/useAdminApi";
import { activeAgentId, activeAgentIdState } from "../composables/agentScope";

const props = withDefaults(defineProps<{ scope?: "persona" | "system" }>(), { scope: "persona" });

const route = useRoute();
const router = useRouter();
const overrideSystem = shallowRef(false);
const overrideSaving = shallowRef(false);
const overrideError = shallowRef("");
const library = usePromptLibrary(props.scope, () => overrideSystem.value);
const query = shallowRef("");
const file = shallowRef<AgentFileDetail | null>(null);
const content = shallowRef("");
const baseline = shallowRef("");
const loading = shallowRef(false);
const saving = shallowRef(false);
const message = shallowRef("");
const messageKind = shallowRef<"" | "success" | "error" | "warning">("");
const conflict = shallowRef(false);
const confirmOpen = shallowRef(false);
const pendingPath = shallowRef("");
const selectedId = computed(() => String(route.params.fileId ?? ""));
const basePath = computed(() => props.scope === "system" ? "/system-prompts" : "/agent-prompts");
const pageTitle = computed(() => props.scope === "system" ? "系统提示词" : "人格提示词");
const dirty = computed(() => content.value !== baseline.value);
let openRequestId = 0;

onMounted(async () => {
  if (props.scope === "persona") await loadPromptSettings();
  await library.loadList();
  window.addEventListener("keydown", onShortcut);
  window.addEventListener("beforeunload", onBeforeUnload);
});
onBeforeUnmount(() => {
  window.removeEventListener("keydown", onShortcut);
  window.removeEventListener("beforeunload", onBeforeUnload);
});
watch(selectedId, (id) => void openFile(id), { immediate: true });

onBeforeRouteUpdate((to) => guardNavigation(to));
onBeforeRouteLeave((to) => guardNavigation(to));

async function openFile(id: string) {
  const requestId = ++openRequestId;
  if (!id) {
    file.value = null;
    content.value = "";
    baseline.value = "";
    loading.value = false;
    return;
  }
  loading.value = true;
  conflict.value = false;
  try {
    const result = await library.loadFile(id);
    if (requestId !== openRequestId || id !== selectedId.value) return;
    file.value = result;
    content.value = result.content;
    baseline.value = result.content;
    setMessage("", "");
  } catch (error) {
    if (requestId !== openRequestId || id !== selectedId.value) return;
    file.value = null;
    setMessage(`读取失败：${error instanceof Error ? error.message : "提示词正文读取失败"}`, "error");
  } finally {
    if (requestId === openRequestId) loading.value = false;
  }
}

function selectFile(id: string) {
  if (id === selectedId.value) return;
  if (dirty.value) {
    pendingPath.value = `${basePath.value}/${encodeURIComponent(id)}`;
    confirmOpen.value = true;
    return;
  }
  void router.push(`${basePath.value}/${encodeURIComponent(id)}`);
}

async function save(): Promise<boolean> {
  if (!file.value) return false;
  if (!dirty.value) return true;
  saving.value = true;
  try {
    const result = await library.saveFile(file.value, content.value);
    file.value = result;
    content.value = result.content;
    baseline.value = result.content;
    conflict.value = false;
    setMessage("已保存", "success");
    return true;
  } catch (error) {
    if (error instanceof ApiRequestError && error.status === 409) {
      conflict.value = true;
      setMessage("服务器版本已更新", "error");
    } else {
      setMessage(`保存失败：${error instanceof Error ? error.message : "请稍后重试"}`, "error");
    }
    return false;
  } finally {
    saving.value = false;
  }
}

async function saveAndContinue() {
  const path = pendingPath.value;
  if (!await save()) return;
  confirmOpen.value = false;
  pendingPath.value = "";
  if (path) void router.push(path);
}

function discard() {
  content.value = baseline.value;
  conflict.value = false;
  setMessage("已撤销修改", "warning");
}

async function loadServer() {
  if (!file.value) return;
  await openFile(file.value.id);
}

async function keepLocal() {
  if (!file.value) return;
  const local = content.value;
  try {
    const latest = await library.loadFile(file.value.id);
    file.value = latest;
    baseline.value = latest.content;
    content.value = local;
    conflict.value = false;
    setMessage("已保留当前内容，请保存", "warning");
  } catch (error) {
    setMessage(`读取失败：${error instanceof Error ? error.message : "最新版本读取失败"}`, "error");
  }
}

function onShortcut(event: KeyboardEvent) {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
    event.preventDefault();
    void save();
  }
}

function onBeforeUnload(event: BeforeUnloadEvent) {
  if (!dirty.value) return;
  event.preventDefault();
  event.returnValue = "";
}

function guardNavigation(to: RouteLocationNormalized) {
  if (!dirty.value) return true;
  pendingPath.value = to.fullPath;
  confirmOpen.value = true;
  return false;
}

function continueNavigation() {
  const path = pendingPath.value;
  discard();
  confirmOpen.value = false;
  pendingPath.value = "";
  if (path) void router.push(path);
}

function cancelNavigation() {
  confirmOpen.value = false;
  pendingPath.value = "";
}

function backToList() {
  if (dirty.value) {
    pendingPath.value = basePath.value;
    confirmOpen.value = true;
  } else void router.push(basePath.value);
}

async function loadPromptSettings() {
  try {
    const settings = await apiRequest<{ overrideSystem: boolean }>(
      `/api/agents/${encodeURIComponent(activeAgentId())}/prompt-settings`
    );
    overrideSystem.value = settings.overrideSystem;
    overrideError.value = "";
  } catch (error) {
    overrideError.value = error instanceof Error ? error.message : "设置读取失败";
  }
}

async function setSystemOverride(value: boolean) {
  if (overrideSaving.value || value === overrideSystem.value) return;
  if (dirty.value) {
    overrideError.value = "请先保存或撤销当前修改";
    return;
  }
  overrideSaving.value = true;
  overrideError.value = "";
  try {
    const settings = await apiRequest<{ overrideSystem: boolean }>(
      `/api/agents/${encodeURIComponent(activeAgentId())}/prompt-settings`,
      { method: "PATCH", body: JSON.stringify({ overrideSystem: value }) }
    );
    overrideSystem.value = settings.overrideSystem;
    if (!settings.overrideSystem && selectedId.value && !selectedId.value.startsWith("persona.")) {
      await router.push(basePath.value);
    }
    await library.loadList();
  } catch (error) {
    overrideError.value = error instanceof Error ? error.message : "设置保存失败";
  } finally {
    overrideSaving.value = false;
  }
}

async function soulImported() {
  await library.loadList();
  if (selectedId.value) await openFile(selectedId.value);
  setMessage("灵魂文件已导入", "success");
}

function setMessage(value: string, kind: "" | "success" | "error" | "warning") {
  message.value = value;
  messageKind.value = kind;
}
</script>

<template>
  <div class="h-full min-h-0 min-w-0 overflow-hidden">
    <div class="grid h-full min-h-0 min-w-0 lg:grid-cols-[280px_minmax(0,1fr)] xl:grid-cols-[336px_minmax(0,1fr)]">
      <PromptFileList
        :class="selectedId ? 'hidden lg:flex' : 'flex'"
        :files="library.files.value"
        :selected-id="selectedId"
        :query="query"
        :error="library.listError.value"
        :title="pageTitle"
        @select="selectFile"
        @update:query="query = $event"
      >
        <template v-if="props.scope === 'persona'" #headerAfter>
          <AgentSoulControls :agent-id="activeAgentIdState" :disabled="dirty || saving" @imported="soulImported" />
          <div class="border-b border-line py-2">
            <ToggleSwitch
              :model-value="overrideSystem"
              label="覆盖系统提示词"
              description="为当前 Agent 使用独立系统提示词"
              :disabled="overrideSaving"
              @update:model-value="setSystemOverride"
            />
          </div>
          <p v-if="overrideError" class="mt-3 text-xs text-accent">{{ overrideError }}</p>
        </template>
      </PromptFileList>
      <PromptEditor
        :class="selectedId ? 'flex' : 'hidden lg:flex'"
        v-model="content"
        :file="file"
        :loading="loading"
        :dirty="dirty"
        :saving="saving"
        :message="message"
        :message-kind="messageKind"
        :conflict="conflict"
        @save="save"
        @discard="discard"
        @back="backToList"
        @load-server="loadServer"
        @keep-local="keepLocal"
      />
    </div>

    <DialogOverlay :open="confirmOpen" labelledby="unsaved-title" @close="cancelNavigation">
      <section class="w-full max-w-md rounded border border-visible bg-panel p-6">
        <h2 id="unsaved-title" class="text-xl font-medium text-display">放弃未保存的修改？</h2>
        <p class="mt-3 text-sm text-mute">当前正文尚未保存，离开后无法恢复。</p>
        <div class="mt-8 flex justify-end gap-2">
          <button class="btn btn-ghost" type="button" @click="cancelNavigation">继续编辑</button>
          <button class="btn btn-primary" type="button" :disabled="saving" @click="saveAndContinue"><i class="bx bx-save" aria-hidden="true"></i>{{ saving ? "保存中" : "保存并离开" }}</button>
          <button class="btn btn-danger" type="button" @click="continueNavigation">放弃并离开</button>
        </div>
      </section>
    </DialogOverlay>
  </div>
</template>
