<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, shallowRef, watch } from "vue";
import { onBeforeRouteLeave, onBeforeRouteUpdate, useRoute, useRouter, type RouteLocationNormalized } from "vue-router";
import { ApiRequestError } from "../composables/useAdminApi";
import { usePromptLibrary } from "../composables/usePromptLibrary";
import PromptEditor from "../components/prompts/PromptEditor.vue";
import PromptFileList from "../components/prompts/PromptFileList.vue";
import DialogOverlay from "../components/ui/DialogOverlay.vue";
import type { AgentFileDetail } from "../types";

const route = useRoute();
const router = useRouter();
const library = usePromptLibrary();
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
const dirty = computed(() => content.value !== baseline.value);
let openRequestId = 0;

onMounted(() => {
  void library.loadList();
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
    setMessage(`[ERROR: ${error instanceof Error ? error.message : "正文读取失败"}]`, "error");
  } finally {
    if (requestId === openRequestId) loading.value = false;
  }
}

function selectFile(id: string) {
  if (id === selectedId.value) return;
  if (dirty.value) {
    pendingPath.value = `/prompts/${encodeURIComponent(id)}`;
    confirmOpen.value = true;
    return;
  }
  void router.push(`/prompts/${encodeURIComponent(id)}`);
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
    setMessage("[SAVED]", "success");
    return true;
  } catch (error) {
    if (error instanceof ApiRequestError && error.status === 409) {
      conflict.value = true;
      setMessage("[CONFLICT]", "error");
    } else {
      setMessage(`[ERROR: ${error instanceof Error ? error.message : "保存失败"}]`, "error");
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
  setMessage("[DISCARDED]", "warning");
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
    setMessage("[LOCAL RETAINED · SAVE TO APPLY]", "warning");
  } catch (error) {
    setMessage(`[ERROR: ${error instanceof Error ? error.message : "最新版本读取失败"}]`, "error");
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
    pendingPath.value = "/prompts";
    confirmOpen.value = true;
  } else void router.push("/prompts");
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
        @select="selectFile"
        @update:query="query = $event"
      />
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
        <p class="page-kicker">UNSAVED</p>
        <h2 id="unsaved-title" class="mt-2 text-xl font-medium text-display">放弃未保存的修改？</h2>
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
