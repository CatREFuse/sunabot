<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, shallowRef, watch } from "vue";
import { ApiRequestError, apiRequest } from "../../composables/useAdminApi";
import type { AgentFileDetail } from "../../types";

const props = defineProps<{ agentId: string }>();
const file = shallowRef<AgentFileDetail | null>(null);
const content = shallowRef("");
const baseline = shallowRef("");
const loading = shallowRef(false);
const saving = shallowRef(false);
const message = shallowRef("");
const messageKind = shallowRef<"" | "success" | "error" | "warning">("");
const dirty = computed(() => content.value !== baseline.value);
let contextGeneration = 0;

watch(() => props.agentId, () => {
  contextGeneration += 1;
  file.value = null;
  content.value = "";
  baseline.value = "";
  saving.value = false;
  setMessage("", "");
  void load();
}, { immediate: true });
onMounted(() => window.addEventListener("keydown", saveShortcut));
onBeforeUnmount(() => window.removeEventListener("keydown", saveShortcut));

async function load() {
  const generation = contextGeneration;
  const agentId = props.agentId;
  loading.value = true;
  try {
    const payload = await apiRequest<{ file?: AgentFileDetail }>(
      `/api/agent-files/persona.air?agentId=${encodeURIComponent(agentId)}`
    );
    if (generation !== contextGeneration || agentId !== props.agentId) return;
    const next = payload.file ?? payload as unknown as AgentFileDetail;
    file.value = next;
    content.value = next.content;
    baseline.value = next.content;
    setMessage("", "");
  } catch (error) {
    if (generation !== contextGeneration || agentId !== props.agentId) return;
    setMessage(error instanceof Error ? error.message : "读取失败", "error");
  } finally {
    if (generation === contextGeneration && agentId === props.agentId) loading.value = false;
  }
}

async function save() {
  if (!file.value || !dirty.value) return;
  const generation = contextGeneration;
  const agentId = props.agentId;
  saving.value = true;
  try {
    const payload = await apiRequest<{ file?: AgentFileDetail }>(
      `/api/agent-files/persona.air?agentId=${encodeURIComponent(agentId)}`,
      {
        method: "PUT",
        body: JSON.stringify({ content: content.value, revision: file.value.revision })
      }
    );
    if (generation !== contextGeneration || agentId !== props.agentId) return;
    const next = payload.file ?? payload as unknown as AgentFileDetail;
    file.value = next;
    content.value = next.content;
    baseline.value = next.content;
    setMessage("已保存", "success");
  } catch (error) {
    if (generation !== contextGeneration || agentId !== props.agentId) return;
    setMessage(
      error instanceof ApiRequestError && error.status === 409
        ? "内容已更新，请刷新后重试"
        : error instanceof Error ? error.message : "保存失败",
      "error"
    );
  } finally {
    if (generation === contextGeneration && agentId === props.agentId) saving.value = false;
  }
}

function discard() {
  content.value = baseline.value;
  setMessage("已撤销修改", "warning");
}

function saveShortcut(event: KeyboardEvent) {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
    event.preventDefault();
    void save();
  }
}

function setMessage(value: string, kind: typeof messageKind.value) {
  message.value = value;
  messageKind.value = kind;
}
</script>

<template>
  <section class="border-y border-visible" aria-label="场域知识">
    <header class="flex flex-wrap items-center justify-between gap-3 border-b border-line py-4">
      <div class="min-w-0">
        <h2 class="font-mono text-xs text-display">{{ file?.fileName || "AIR.md" }}</h2>
        <p class="mt-1 text-xs text-mute">公共语境、群聊场域与关系背景</p>
      </div>
      <div class="flex items-center gap-2">
        <button class="btn btn-ghost" type="button" :disabled="loading || saving" @click="load">
          <i class="bx bx-refresh" :class="loading ? 'bx-spin' : ''" aria-hidden="true"></i>刷新
        </button>
        <button class="icon-btn" type="button" :disabled="!dirty || saving" aria-label="撤销修改" @click="discard">
          <i class="bx bx-reset text-xl" aria-hidden="true"></i>
        </button>
        <button class="btn btn-primary" type="button" :disabled="!dirty || saving" @click="save">
          <i class="bx bx-save" aria-hidden="true"></i>{{ saving ? "保存中" : "保存" }}
        </button>
      </div>
    </header>
    <div v-if="loading && !file" class="empty-state"><div><strong>正在读取场域知识</strong></div></div>
    <div v-else class="py-5">
      <label class="field">
        <span class="sr-only">场域知识正文</span>
        <textarea
          v-model="content"
          class="control min-h-[420px] resize-y font-mono text-xs leading-6"
          spellcheck="false"
          aria-label="场域知识正文"
        ></textarea>
      </label>
      <footer class="mt-3 flex flex-wrap items-center justify-between gap-2 font-mono text-[10px] text-mute">
        <span>{{ content.split("\n").length }} 行 · {{ content.length }} 字符</span>
        <span class="inline-state" :data-kind="messageKind || undefined">{{ message || (dirty ? "未保存" : "") }}</span>
        <span>⌘/Ctrl + S</span>
      </footer>
    </div>
  </section>
</template>
