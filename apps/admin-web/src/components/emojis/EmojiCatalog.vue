<script setup lang="ts">
import { computed, onBeforeUnmount, shallowRef, watch } from "vue";
import type { EmojiRecord, EmojiUploadInput } from "../../types/emojis";
import { useEmojis } from "../../composables/useEmojis";
import PageHeader from "../ui/PageHeader.vue";
import EmojiCard from "./EmojiCard.vue";
import EmojiDeleteDialog from "./EmojiDeleteDialog.vue";
import EmojiEditorDialog from "./EmojiEditorDialog.vue";

const props = defineProps<{ agentId: string }>();
const data = useEmojis();
const editorOpen = shallowRef(false);
const editorKey = shallowRef("");
const pendingDelete = shallowRef<EmojiRecord | null>(null);
const emojiByKey = computed(() => new Map(data.emojis.value.map((emoji) => [emoji.key, emoji])));
const presetEntries = computed(() => data.presetKeys.value.map((key) => ({ key, emoji: emojiByKey.value.get(key) ?? null })));
const presetSet = computed(() => new Set(data.presetKeys.value));
const customEmojis = computed(() => data.emojis.value
  .filter((emoji) => !presetSet.value.has(emoji.key))
  .sort((left, right) => left.key.localeCompare(right.key, "zh-CN")));
const installedPresetCount = computed(() => presetEntries.value.filter((entry) => entry.emoji).length);
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

function openEditor(key = "") {
  data.clearStatus();
  editorKey.value = key;
  editorOpen.value = true;
}

async function save(input: EmojiUploadInput) {
  if (await data.upload(props.agentId, input)) editorOpen.value = false;
}

async function generate(key: string) {
  await data.generate(props.agentId, key);
}

async function confirmDelete() {
  const emoji = pendingDelete.value;
  if (!emoji) return;
  if (await data.remove(props.agentId, emoji.key)) pendingDelete.value = null;
}
</script>

<template>
  <div class="page-shell">
    <div class="page-frame">
      <PageHeader title="表情">
        <template #titleAfter>
          <span v-if="data.presetKeys.value.length" class="inline-state"><i class="bx bx-images" aria-hidden="true"></i>{{ installedPresetCount }} / {{ data.presetKeys.value.length }}</span>
        </template>
        <template #actions>
          <span v-if="data.status.value.message" class="inline-state" :data-kind="data.status.value.kind === 'idle' ? undefined : data.status.value.kind">{{ data.status.value.message }}</span>
          <button class="icon-btn" type="button" :disabled="data.loading.value" aria-label="刷新表情" @click="data.load(agentId)"><i class="bx bx-refresh text-xl" :class="data.loading.value ? 'bx-spin' : ''" aria-hidden="true"></i></button>
          <button class="btn btn-primary" type="button" @click="openEditor()"><i class="bx bx-plus" aria-hidden="true"></i>新增</button>
        </template>
      </PageHeader>

      <section aria-labelledby="preset-emojis-title">
        <div class="flex flex-wrap items-end justify-between gap-4 border-t border-visible pt-8">
          <h2 id="preset-emojis-title" class="section-title">预设表情</h2>
          <span class="font-mono text-[10px] text-mute">{{ installedPresetCount.toLocaleString("zh-CN") }} / {{ data.presetKeys.value.length.toLocaleString("zh-CN") }}</span>
        </div>
        <div v-if="presetEntries.length" class="mt-6 grid grid-cols-1 gap-x-5 gap-y-10 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          <EmojiCard
            v-for="entry in presetEntries"
            :key="entry.key"
            :emoji-key="entry.key"
            :emoji="entry.emoji"
            preset
            :generating="data.generatingKeys.value.has(entry.key)"
            :deleting="data.deletingKey.value === entry.key"
            @generate="generate"
            @edit="openEditor"
            @remove="pendingDelete = $event"
          />
        </div>
        <div v-else class="empty-state min-h-48">
          <div><strong>{{ data.loading.value ? "正在读取表情" : "没有预设表情" }}</strong></div>
        </div>
      </section>

      <section class="mt-14" aria-labelledby="custom-emojis-title">
        <div class="flex flex-wrap items-end justify-between gap-4 border-t border-visible pt-8">
          <h2 id="custom-emojis-title" class="section-title">自定义表情</h2>
          <span class="font-mono text-[10px] text-mute">{{ customEmojis.length.toLocaleString("zh-CN") }} 张</span>
        </div>
        <div v-if="customEmojis.length" class="mt-6 grid grid-cols-1 gap-x-5 gap-y-10 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          <EmojiCard
            v-for="emoji in customEmojis"
            :key="emoji.key"
            :emoji-key="emoji.key"
            :emoji="emoji"
            :preset="false"
            :generating="data.generatingKeys.value.has(emoji.key)"
            :deleting="data.deletingKey.value === emoji.key"
            @generate="generate"
            @edit="openEditor"
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
      :busy="data.uploading.value"
      :error="editorError"
      @close="editorOpen = false"
      @save="save"
    />
    <EmojiDeleteDialog
      :emoji="pendingDelete"
      :busy="Boolean(pendingDelete && data.deletingKey.value === pendingDelete.key)"
      @close="pendingDelete = null"
      @confirm="confirmDelete"
    />
  </div>
</template>
