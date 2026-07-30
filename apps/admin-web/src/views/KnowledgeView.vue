<script setup lang="ts">
import { computed, onBeforeUnmount, shallowRef, watch } from "vue";
import { activeAgentIdState } from "../composables/agentScope";
import { useKnowledgeBase } from "../composables/useKnowledgeBase";
import KnowledgeBrowser from "../components/knowledge/KnowledgeBrowser.vue";
import KnowledgeSearchPanel from "../components/knowledge/KnowledgeSearchPanel.vue";
import KnowledgeUploadDialog from "../components/knowledge/KnowledgeUploadDialog.vue";
import PageHeader from "../components/ui/PageHeader.vue";
import type { KnowledgeDocument } from "../types/knowledge";
import { workbenchResourceKey } from "../types/workbench";

const data = useKnowledgeBase();
const agentId = computed(() => activeAgentIdState.value || "plana");
const query = shallowRef("");
const uploadOpen = shallowRef(false);
const uploadError = shallowRef("");
const pendingDelete = shallowRef("");
const status = shallowRef("");
const statusKind = shallowRef<"success" | "error" | "">("");
const documents = computed(() => data.snapshot.value?.documents ?? []);

watch(agentId, (nextAgentId) => {
  query.value = "";
  uploadOpen.value = false;
  uploadError.value = "";
  pendingDelete.value = "";
  status.value = "";
  statusKind.value = "";
  void data.load(nextAgentId);
}, { immediate: true });
onBeforeUnmount(data.dispose);

async function reindex() {
  const ok = await data.reindex(agentId.value);
  status.value = ok
    ? `扫描完成 · ${data.snapshot.value?.fileCount ?? 0} 个文件`
    : data.error.value;
  statusKind.value = ok ? "success" : "error";
}

async function search() {
  const value = query.value.trim();
  if (!value) return;
  const ok = await data.search(value, agentId.value);
  status.value = ok ? `找到 ${data.matches.value.length} 个分段` : data.error.value;
  statusKind.value = ok ? "success" : "error";
}

function clearSearch() {
  query.value = "";
  data.clearSearch();
  status.value = "";
  statusKind.value = "";
}

async function upload(input: { path: string; content: string }) {
  uploadError.value = "";
  try {
    const ok = await data.upload(input, agentId.value);
    if (!ok) return;
    uploadOpen.value = false;
    status.value = "已添加";
    statusKind.value = "success";
  } catch (error) {
    uploadError.value = error instanceof Error ? error.message : "添加失败";
  }
}

async function remove(document: KnowledgeDocument) {
  const key = workbenchResourceKey(document.workbench ?? "native", document.path);
  if (pendingDelete.value !== key) {
    pendingDelete.value = key;
    return;
  }
  const ok = await data.remove(document, agentId.value);
  pendingDelete.value = "";
  status.value = ok ? "已删除" : data.error.value;
  statusKind.value = ok ? "success" : "error";
}
</script>

<template>
  <div class="page-shell">
    <div class="page-frame">
      <PageHeader title="知识库">
        <template #actions>
          <span v-if="status" class="inline-state" :data-kind="statusKind || undefined">{{ status }}</span>
          <button class="btn" type="button" :disabled="data.loading.value || data.mutating.value" @click="reindex">
            <i class="bx bx-refresh" aria-hidden="true"></i>扫描
          </button>
          <button class="btn btn-primary" type="button" @click="uploadOpen = true">
            <i class="bx bx-plus" aria-hidden="true"></i>添加 Markdown
          </button>
        </template>
      </PageHeader>

      <section aria-label="知识库统计" class="mb-8 grid grid-cols-3 border-y border-visible">
        <div class="border-r border-line py-4 pr-4">
          <span class="meta-label">文件</span>
          <strong class="mt-2 block font-mono text-2xl font-normal text-display">{{ data.snapshot.value?.fileCount ?? 0 }}</strong>
        </div>
        <div class="border-r border-line px-4 py-4">
          <span class="meta-label">分段</span>
          <strong class="mt-2 block font-mono text-2xl font-normal text-display">{{ data.snapshot.value?.chunkCount ?? 0 }}</strong>
        </div>
        <div class="py-4 pl-4">
          <span class="meta-label">异常</span>
          <strong class="mt-2 block font-mono text-2xl font-normal" :class="(data.snapshot.value?.errorCount ?? 0) ? 'text-accent' : 'text-display'">{{ data.snapshot.value?.errorCount ?? 0 }}</strong>
        </div>
      </section>

      <p v-if="data.error.value && !status" class="mb-6 text-sm text-accent" role="alert">{{ data.error.value }}</p>
      <KnowledgeSearchPanel
        v-model="query"
        :matches="data.matches.value"
        :active="data.searchActive.value"
        :searching="data.searching.value"
        @search="search"
        @clear="clearSearch"
      />
      <KnowledgeBrowser
        :documents="documents"
        :loading="data.loading.value"
        :busy="data.mutating.value"
        :pending-delete="pendingDelete"
        @remove="remove"
        @add="uploadOpen = true"
      />
    </div>

    <KnowledgeUploadDialog
      :open="uploadOpen"
      :busy="data.mutating.value"
      :error="uploadError"
      @close="uploadOpen = false"
      @upload="upload"
    />
  </div>
</template>
