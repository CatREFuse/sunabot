<script setup lang="ts">
import { computed, nextTick, useTemplateRef, watch } from "vue";
import { authenticatedMediaPath } from "../../composables/useAdminApi";
import type { ConversationMessageRecord } from "../../types";
import { formatFullDateTime } from "../../utils/format";
import { displayMessageText } from "../../utils/messageText";
import AuthenticatedImage from "../ui/AuthenticatedImage.vue";

const props = defineProps<{
  messages: readonly ConversationMessageRecord[];
  loading: boolean;
  scrollRevision: number;
}>();
const emit = defineEmits<{ contentLoad: [] }>();
const feed = useTemplateRef<HTMLElement>("feed");
const entries = computed(() => props.messages.map((message) => ({
  message,
  fromUser: message.role === "user",
  event: message.role === "event",
  name: message.role === "user"
    ? message.senderName?.trim() || "管理员"
    : message.senderName?.trim() || "普拉娜",
  text: displayMessageText(message.text, message.imageUrls)
})));

watch(() => props.scrollRevision, async () => {
  await nextTick();
  scrollToEnd();
}, { immediate: true, flush: "post" });

function scrollToEnd() {
  if (feed.value) feed.value.scrollTop = feed.value.scrollHeight;
}

function contentLoaded() {
  scrollToEnd();
  emit("contentLoad");
}
</script>

<template>
  <section
    ref="feed"
    data-slot="web-chat-feed"
    class="min-h-0 flex-1 overflow-y-auto px-4 py-6 md:px-8 md:py-10"
    aria-label="Web Chat 消息"
    aria-live="polite"
    :aria-busy="loading"
    @load.capture="contentLoaded"
  >
    <div class="mx-auto w-full max-w-4xl">
      <p v-if="loading && !entries.length" class="py-24 text-center font-mono text-xs uppercase tracking-[0.08em] text-mute">
        [LOADING...]
      </p>
      <div v-else-if="!entries.length" class="grid min-h-64 place-items-center py-24 text-center">
        <div>
          <strong class="text-lg font-normal text-mute">开始对话</strong>
          <p class="mt-2 font-mono text-xs uppercase tracking-[0.06em] text-disabled">WEB:ADMIN</p>
        </div>
      </div>
      <div v-else class="grid">
        <article
          v-for="entry in entries"
          :key="entry.message.id"
          class="grid w-[94%] gap-3 border-t border-line py-6 md:w-[84%] md:py-8"
          :class="entry.event ? 'mx-auto w-full text-center md:w-full' : entry.fromUser ? 'ml-auto text-right' : 'mr-auto'"
        >
          <header
            class="flex flex-wrap items-center gap-x-3 gap-y-1"
            :class="entry.event ? 'justify-center' : entry.fromUser ? 'justify-end' : 'justify-start'"
          >
            <strong class="text-sm font-medium text-display">{{ entry.event ? "SYSTEM" : entry.name }}</strong>
            <span v-if="!entry.event" class="font-mono text-[10px] uppercase tracking-[0.08em] text-mute">
              {{ entry.fromUser ? "ADMIN" : "AGENT" }}
            </span>
            <time class="font-mono text-[10px] text-disabled">{{ formatFullDateTime(entry.message.at) }}</time>
          </header>

          <p
            v-if="entry.message.requestStatus === 'running'"
            class="font-mono text-xs uppercase tracking-[0.06em] text-mute"
            role="status"
          >
            [THINKING...]
          </p>
          <p
            v-else-if="entry.text"
            class="whitespace-pre-wrap break-words text-base leading-7 text-ink md:text-lg md:leading-8"
          >
            {{ entry.text }}
          </p>

          <div v-if="entry.message.imageUrls?.length" class="grid gap-4 pt-2 sm:grid-cols-2">
            <a
              v-for="url in entry.message.imageUrls"
              :key="url"
              :href="authenticatedMediaPath(url)"
              target="_blank"
              rel="noopener noreferrer"
              title="打开原图"
            >
              <AuthenticatedImage
                :src="url"
                thumbnail
                alt="会话图片"
                class-name="max-h-80 w-full object-contain"
              />
            </a>
          </div>
        </article>
      </div>
    </div>
  </section>
</template>
