<script setup lang="ts">
import { computed } from "vue";
import type { KnowledgeDocument } from "../../types/knowledge";
import { workbenchLabel, workbenchResourceKey } from "../../types/workbench";

const props = defineProps<{
  documents: readonly KnowledgeDocument[];
  loading: boolean;
  busy: boolean;
  pendingDelete: string;
}>();
const emit = defineEmits<{
  remove: [document: KnowledgeDocument];
  add: [];
}>();

const directoryGroups = computed(() => {
  const groups = new Map<string, KnowledgeDocument[]>();
  for (const document of props.documents) {
    const separator = document.path.lastIndexOf("/");
    const source = document.workbench ?? "native";
    const directory = separator >= 0 ? document.path.slice(0, separator) : "";
    const groupKey = `${source}:${directory}`;
    const entries = groups.get(groupKey) ?? [];
    entries.push(document);
    groups.set(groupKey, entries);
  }
  return [...groups.values()].map((documents) => ({
    workbench: documents[0]?.workbench ?? "native",
    directory: documents[0]?.path.includes("/")
      ? documents[0].path.slice(0, documents[0].path.lastIndexOf("/"))
      : "",
    documents
  }));
});

function fileName(documentPath: string) {
  return documentPath.split("/").at(-1) ?? documentPath;
}

function formatLabel(document: KnowledgeDocument) {
  if (document.format === "markdown") return "Markdown";
  if (document.format === "jsonl") return "JSONL";
  return "文本";
}

function formatBytes(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(value < 10 * 1024 ? 1 : 0)} KiB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
}

function errorLabel(code: string | undefined) {
  if (code === "KNOWLEDGE_FILE_TOO_LARGE") return "文件超过 8 MiB";
  if (code === "KNOWLEDGE_FILE_INVALID_UTF8") return "UTF-8 无效";
  if (code === "KNOWLEDGE_FILE_LINKED") return "文件链接无效";
  if (code === "KNOWLEDGE_FILE_CHANGED") return "文件正在变化";
  return "索引失败";
}
</script>

<template>
  <section aria-labelledby="knowledge-files-heading" class="border-t border-visible">
    <div class="flex min-h-16 items-center justify-between gap-4 border-b border-line py-3">
      <h2 id="knowledge-files-heading" class="section-title">资料</h2>
      <span class="font-mono text-xs text-mute">{{ documents.length }} 个文件</span>
    </div>

    <template v-for="group in directoryGroups" :key="`${group.workbench}:${group.directory || '/'}`">
      <div class="flex min-h-12 items-center gap-2 border-b border-line py-3 font-mono text-xs text-mute">
        <i class="bx bx-folder" aria-hidden="true"></i>
        <span class="inline-state shrink-0 px-1.5 py-0.5 text-[9px]">{{ workbenchLabel(group.workbench) }}</span>
        <span class="break-all">{{ group.directory || "根目录" }}</span>
      </div>
      <article
        v-for="document in group.documents"
        :key="workbenchResourceKey(document.workbench ?? 'native', document.path)"
        class="grid min-w-0 gap-3 border-b border-line py-4 md:grid-cols-[minmax(0,1fr)_auto] md:items-center"
      >
        <div class="min-w-0">
          <div class="flex min-w-0 items-center gap-2">
            <i class="bx bx-file-blank shrink-0 text-xl text-mute" aria-hidden="true"></i>
            <strong class="min-w-0 break-all text-sm font-medium text-display">{{ fileName(document.path) }}</strong>
          </div>
          <div class="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 pl-7 font-mono text-[11px] text-mute">
            <span>{{ formatLabel(document) }}</span>
            <span>{{ formatBytes(document.sizeBytes) }}</span>
            <span>{{ document.chunkCount }} 个分段</span>
            <span v-if="document.status === 'error'" class="text-accent">{{ errorLabel(document.errorCode) }}</span>
          </div>
        </div>
        <button
          class="btn justify-self-start md:justify-self-end"
          :class="pendingDelete === workbenchResourceKey(document.workbench ?? 'native', document.path) ? 'btn-danger' : 'btn-ghost'"
          type="button"
          :disabled="busy"
          :aria-label="`${pendingDelete === workbenchResourceKey(document.workbench ?? 'native', document.path) ? '确认删除' : '删除'} ${workbenchLabel(document.workbench ?? 'native')} ${document.path}`"
          @click="emit('remove', document)"
        >
          <i class="bx bx-trash" aria-hidden="true"></i>
          {{ pendingDelete === workbenchResourceKey(document.workbench ?? "native", document.path) ? "确认删除" : "删除" }}
        </button>
      </article>
    </template>

    <div v-if="!documents.length" class="empty-state">
      <div v-if="loading"><strong>正在扫描</strong></div>
      <div v-else>
        <strong>暂无资料</strong>
        <button class="btn btn-primary mt-5" type="button" @click="emit('add')">
          <i class="bx bx-plus" aria-hidden="true"></i>添加 Markdown
        </button>
      </div>
    </div>
  </section>
</template>
