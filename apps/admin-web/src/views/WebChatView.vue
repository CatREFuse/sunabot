<script setup lang="ts">
import WebChatComposer from "../components/webChat/WebChatComposer.vue";
import WebChatFeed from "../components/webChat/WebChatFeed.vue";
import { useWebChat } from "../composables/useWebChat";
import { useAgents } from "../composables/useAgents";

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
const agentsState = useAgents();
</script>

<template>
  <div class="flex h-full min-h-0 flex-col bg-page">
    <header class="flex flex-wrap items-end justify-between gap-6 border-b border-line px-4 py-6 md:px-8 md:py-8">
      <div class="min-w-0">
        <h1 class="page-title">
          与{{ agentsState.currentAgent.value?.name || "Agent" }}对话
        </h1>
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
