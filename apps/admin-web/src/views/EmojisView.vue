<script setup lang="ts">
import { computed } from "vue";
import { activeAgentIdState } from "../composables/agentScope";
import EmojiCatalog from "../components/emojis/EmojiCatalog.vue";

const agentId = computed(() => activeAgentIdState.value || "plana");
</script>

<template>
  <EmojiCatalog :agent-id="agentId" />
</template>
