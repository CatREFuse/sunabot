<script setup lang="ts">
import { computed, onBeforeUnmount, shallowRef, watch } from "vue";
import type { EmojiRecord, EmojiUploadInput } from "../../types/emojis";
import type { WorkbenchBackend } from "../../types/workbench";
import { workbenchResourceKey } from "../../types/workbench";
import { useEmojis } from "../../composables/useEmojis";
import PageHeader from "../ui/PageHeader.vue";
import EmojiCard from "./EmojiCard.vue";
import EmojiDeleteDialog from "./EmojiDeleteDialog.vue";
import EmojiEditorDialog from "./EmojiEditorDialog.vue";
import EmojiSendSizeSettings from "./EmojiSendSizeSettings.vue";
import EmojiVersionsDialog from "./EmojiVersionsDialog.vue";

const props = defineProps<{ agentId: string }>();
const data = useEmojis();
const editorOpen = shallowRef(false);
const editorKey = shallowRef("");
const editorWorkbench = shallowRef<WorkbenchBackend>("native");
const pendingDelete = shallowRef<EmojiRecord | null>(null);
interface PresetEntry {
  key: string;
  emoji: EmojiRecord | null;
  workbench: WorkbenchBackend;
}
const emojisByKey = computed(() => {
  const records = new Map<string, EmojiRecord[]>();
  for (const emoji of data.emojis.value) {
    const matches = records.get(emoji.key) ?? [];
    matches.push(emoji);
    records.set(emoji.key, matches);
  }
  return records;
});
const presetEntries = computed<PresetEntry[]>(() => {
  const entries: PresetEntry[] = [];
  for (const key of data.presetKeys.value) {
    const records = emojisByKey.value.get(key) ?? [];
    if (!records.length) {
      entries.push({ key, emoji: null, workbench: "native" });
      continue;
    }
    entries.push(...records.map((emoji) => ({
      key,
      emoji,
      workbench: emoji.workbench ?? "native"
    })));
  }
  return entries;
});
const presetSet = computed(() => new Set(data.presetKeys.value));
const customEmojis = computed(() => data.emojis.value
  .filter((emoji) => !presetSet.value.has(emoji.key))
  .sort((left, right) => left.key.localeCompare(right.key, "zh-CN")
    || (left.workbench ?? "native").localeCompare(right.workbench ?? "native")));
const installedPresetCount = computed(() => data.presetKeys.value
  .filter((key) => (emojisByKey.value.get(key)?.length ?? 0) > 0).length);
const nativeCount = computed(() => data.emojis.value.filter((emoji) => (emoji.workbench ?? "native") === "native").length);
const dockerCount = computed(() => data.emojis.value.filter((emoji) => emoji.workbench === "docker").length);
const editorError = computed(() => data.status.value.kind === "error" ? data.status.value.message : "");

watch(
  () => props.agentId,
  (agentId) => {
    editorOpen.value = false;
    pendingDelete.value = null;
    void data.load(agentId);
  },
  { immediate: true }
);
onBeforeUnmount(data.dispose);

function openEditor(key = "", workbench: WorkbenchBackend = "native") {
  data.clearStatus();
  editorKey.value = key;
  editorWorkbench.value = workbench;
  editorOpen.value = true;
}

async function save(input: EmojiUploadInput) {
  if (await data.upload(props.agentId, input, editorWorkbench.value)) editorOpen.value = false;
}

async function generate(key: string, workbench: WorkbenchBackend) {
  await data.generate(props.agentId, key, workbench);
}

async function uploadDropped(key: string, file: File, workbench: WorkbenchBackend) {
  await data.upload(props.agentId, { key, file }, workbench);
}

async function rename(key: string, nextKey: string, workbench: WorkbenchBackend) {
  await data.rename(props.agentId, key, nextKey, workbench);
}

function openVersions(key: string, workbench: WorkbenchBackend) {
  data.clearStatus();
  void data.loadVersions(props.agentId, key, workbench);
}

async function confirmDelete() {
  const emoji = pendingDelete.value;
  if (!emoji) return;
  if (await data.remove(props.agentId, emoji.key, emoji.workbench ?? "native")) pendingDelete.value = null;
}
</script>

<template>
  <div class="page-shell">
    <div class="page-frame">
      <PageHeader title="表情">
        <template #titleAfter>
          <div class="flex flex-wrap items-center gap-2">
            <span v-if="data.presetKeys.value.length" class="inline-state"><i class="bx bx-images" aria-hidden="true"></i>{{ installedPresetCount }} / {{ data.presetKeys.value.length }}</span>
            <span class="inline-state">Native {{ nativeCount }} · Docker {{ dockerCount }}</span>
          </div>
        </template>
        <template #actions>
          <span v-if="data.status.value.message" class="inline-state" :data-kind="data.status.value.kind === 'idle' ? undefined : data.status.value.kind">{{ data.status.value.message }}</span>
          <button class="icon-btn" type="button" :disabled="data.loading.value" aria-label="刷新表情" @click="data.load(agentId)"><i class="bx bx-refresh text-xl" :class="data.loading.value ? 'bx-spin' : ''" aria-hidden="true"></i></button>
          <button class="btn btn-primary" type="button" @click="openEditor()"><i class="bx bx-plus" aria-hidden="true"></i>新增</button>
        </template>
      </PageHeader>

      <EmojiSendSizeSettings
        :model-value="data.sendSize.value"
        :send-separately="data.sendSeparately.value"
        :saving="data.savingSettings.value"
        @change="data.setSendSize(agentId, $event)"
        @separate-change="data.setSendSeparately(agentId, $event)"
      />

      <section aria-labelledby="preset-emojis-title">
        <div class="flex flex-wrap items-end justify-between gap-4 border-t border-visible pt-5">
          <h2 id="preset-emojis-title" class="section-title">预设表情</h2>
          <span class="font-mono text-[10px] text-mute">{{ installedPresetCount.toLocaleString("zh-CN") }} / {{ data.presetKeys.value.length.toLocaleString("zh-CN") }}</span>
        </div>
        <div v-if="presetEntries.length" class="mt-3 grid grid-cols-1 gap-x-6 xl:grid-cols-2">
          <EmojiCard
            v-for="entry in presetEntries"
            :key="workbenchResourceKey(entry.workbench, entry.key)"
            :emoji-key="entry.key"
            :emoji="entry.emoji"
            :workbench="entry.workbench"
            preset
            :generating="data.generatingKeys.value.has(workbenchResourceKey(entry.workbench, entry.key))"
            :uploading="data.uploadingKey.value === workbenchResourceKey(entry.workbench, entry.key)"
            :deleting="data.deletingKey.value === workbenchResourceKey(entry.workbench, entry.key)"
            @generate="generate($event, entry.workbench)"
            @edit="openEditor($event, entry.workbench)"
            @upload="(key, file) => uploadDropped(key, file, entry.workbench)"
            @rename="(key, nextKey) => rename(key, nextKey, entry.workbench)"
            @versions="openVersions($event, entry.workbench)"
            @remove="pendingDelete = $event"
          />
        </div>
        <div v-else class="empty-state min-h-48">
          <div><strong>{{ data.loading.value ? "正在读取表情" : "没有预设表情" }}</strong></div>
        </div>
      </section>

      <section class="mt-8" aria-labelledby="custom-emojis-title">
        <div class="flex flex-wrap items-end justify-between gap-4 border-t border-visible pt-5">
          <h2 id="custom-emojis-title" class="section-title">自定义表情</h2>
          <span class="font-mono text-[10px] text-mute">{{ customEmojis.length.toLocaleString("zh-CN") }} 张</span>
        </div>
        <div v-if="customEmojis.length" class="mt-3 grid grid-cols-1 gap-x-6 xl:grid-cols-2">
          <EmojiCard
            v-for="emoji in customEmojis"
            :key="workbenchResourceKey(emoji.workbench ?? 'native', emoji.key)"
            :emoji-key="emoji.key"
            :emoji="emoji"
            :workbench="emoji.workbench ?? 'native'"
            :preset="false"
            :generating="data.generatingKeys.value.has(workbenchResourceKey(emoji.workbench ?? 'native', emoji.key))"
            :uploading="data.uploadingKey.value === workbenchResourceKey(emoji.workbench ?? 'native', emoji.key)"
            :deleting="data.deletingKey.value === workbenchResourceKey(emoji.workbench ?? 'native', emoji.key)"
            @generate="generate($event, emoji.workbench ?? 'native')"
            @edit="openEditor($event, emoji.workbench ?? 'native')"
            @upload="(key, file) => uploadDropped(key, file, emoji.workbench ?? 'native')"
            @rename="(key, nextKey) => rename(key, nextKey, emoji.workbench ?? 'native')"
            @versions="openVersions($event, emoji.workbench ?? 'native')"
            @remove="pendingDelete = $event"
          />
        </div>
        <div v-else class="empty-state min-h-48">
          <div><strong>还没有自定义表情</strong><button class="btn btn-ghost mt-4" type="button" @click="openEditor()"><i class="bx bx-plus" aria-hidden="true"></i>新增</button></div>
        </div>
      </section>
    </div>

    <EmojiEditorDialog
      :open="editorOpen"
      :emoji-key="editorKey"
      :workbench="editorWorkbench"
      :busy="data.uploading.value"
      :error="editorError"
      @close="editorOpen = false"
      @save="save"
    />
    <EmojiDeleteDialog
      :emoji="pendingDelete"
      :busy="Boolean(pendingDelete && data.deletingKey.value === workbenchResourceKey(pendingDelete.workbench ?? 'native', pendingDelete.key))"
      @close="pendingDelete = null"
      @confirm="confirmDelete"
    />
    <EmojiVersionsDialog
      :emoji-key="data.versionKey.value"
      :workbench="data.versionWorkbench.value"
      :versions="data.versions.value"
      :loading="data.loadingVersions.value"
      :deleting-file-name="data.deletingVersion.value"
      @close="data.clearVersions"
      @remove="data.removeVersion(agentId, data.versionKey.value, $event.fileName, data.versionWorkbench.value)"
    />
  </div>
</template>
