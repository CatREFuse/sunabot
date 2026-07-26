<script setup lang="ts">
import { computed } from "vue";
import { formatFullDateTime } from "../../utils/format";
import { qqAvatarUrl } from "../../utils/qqIdentity";
import type { MemoryEntry } from "../../types";
import IdentityAvatar from "../ui/IdentityAvatar.vue";

const props = defineProps<{
  entry: MemoryEntry;
  selected: boolean;
}>();
const emit = defineEmits<{ select: [entry: MemoryEntry] }>();

const userProfile = computed(() => props.entry.source === "user_profile" && Boolean(props.entry.userId));
const nickname = computed(() => props.entry.userNickname || props.entry.userName || "未知昵称");
const addressNames = computed(() => props.entry.addressNames?.join("、") || props.entry.addressName || "暂无称呼");
const timestamp = computed(() => props.entry.updatedAt || props.entry.createdAt || props.entry.legacyCreatedAt || props.entry.occurredAt || props.entry.time || props.entry.legacyTime);
const accessibleLabel = computed(() => {
  const identifier = props.entry.key || props.entry.id;
  if (userProfile.value) return `查看${props.entry.sourceTitle}详情：${nickname.value}，${addressNames.value}，编号 ${identifier}`;
  const excerpt = props.entry.text.trim().replace(/\s+/gu, " ").slice(0, 60);
  return `查看${props.entry.sourceTitle}详情：${excerpt}，编号 ${identifier}`;
});
const recallLabel = computed(() => {
  if (props.entry.source !== "long_term") return "";
  const parts = [];
  if (props.entry.recallCount != null) parts.push(`召回 ${props.entry.recallCount} 次`);
  if (props.entry.distinctRecallDays != null) parts.push(`跨 ${props.entry.distinctRecallDays} 天`);
  return parts.join(" · ");
});
</script>

<template>
  <article
    class="group relative border-b border-line transition-colors duration-200"
    :class="selected ? 'bg-raised' : 'hover:bg-raised/60'"
    :aria-current="selected ? 'true' : undefined"
  >
    <button
      class="grid min-h-24 w-full min-w-0 gap-2 bg-transparent px-3 py-3 text-left sm:grid-cols-[minmax(0,1fr)_max-content] sm:items-start sm:gap-6 sm:py-4 lg:px-5"
      type="button"
      :aria-label="accessibleLabel"
      @click="emit('select', entry)"
    >
      <span
        class="absolute bottom-0 left-0 top-0 w-0.5 bg-display transition-opacity duration-200"
        :class="selected ? 'opacity-100' : 'opacity-0 group-focus-within:opacity-100'"
        aria-hidden="true"
      ></span>

      <span v-if="userProfile" class="flex min-w-0 gap-4">
        <IdentityAvatar :src="qqAvatarUrl(entry.userId)" :name="nickname" size="lg" />
        <span class="min-w-0">
          <strong class="block truncate text-base font-medium text-display">{{ nickname }}</strong>
          <span class="mt-1 block truncate text-xs text-mute">{{ addressNames }}</span>
          <span class="mt-3 line-clamp-2 text-sm leading-6 text-ink">{{ entry.text }}</span>
        </span>
      </span>

      <span v-else class="min-w-0">
        <span class="line-clamp-3 text-sm leading-6 text-ink sm:leading-7">{{ entry.text }}</span>
        <span v-if="recallLabel" class="mt-2 block font-mono text-[11px] text-mute sm:mt-3">{{ recallLabel }}</span>
      </span>

      <span class="flex min-w-0 items-center justify-between gap-4 sm:block sm:text-right">
        <span class="hidden max-w-52 truncate font-mono text-[11px] text-mute sm:block">#{{ entry.key || entry.id }}</span>
        <time v-if="timestamp" class="block font-mono text-[11px] text-mute sm:mt-2">{{ formatFullDateTime(timestamp) }}</time>
        <i class="bx bx-right-arrow-alt ml-auto text-xl text-disabled transition-transform duration-200 group-hover:translate-x-1 group-hover:text-display sm:mt-3 sm:block" aria-hidden="true"></i>
      </span>
    </button>
  </article>
</template>
