<script setup lang="ts">
import WebChatComposer from "../components/webChat/WebChatComposer.vue";
import WebChatFeed from "../components/webChat/WebChatFeed.vue";
import { useWebChat } from "../composables/useWebChat";

const {
  messages,
  draft,
  loading,
  sending,
  error,
  scrollRevision,
  send,
  requestScroll
} = useWebChat();
</script>

<template>
  <div class="flex h-full min-h-0 flex-col bg-page">
    <header class="flex flex-wrap items-end justify-between gap-6 border-b border-line px-4 py-6 md:px-8 md:py-8">
      <div class="min-w-0">
        <p class="page-kicker">WEB DELIVERY</p>
        <h1 class="mt-2 font-display text-[48px] font-semibold leading-none tracking-[-0.03em] text-display md:text-[64px]">
          WEB CHAT
        </h1>
        <p class="mt-3 text-sm text-mute md:text-base">与普拉娜对话</p>
      </div>
      <div class="grid justify-items-end gap-1 pb-1 font-mono text-[10px] uppercase tracking-[0.08em]">
        <span class="text-success">[WEB:ADMIN]</span>
        <span class="text-disabled">网页会话</span>
      </div>
    </header>

    <WebChatFeed
      :messages="messages"
      :loading="loading"
      :scroll-revision="scrollRevision"
      @content-load="requestScroll"
    />
    <WebChatComposer v-model="draft" :sending="sending" :error="error" @submit="send" />
  </div>
</template>
