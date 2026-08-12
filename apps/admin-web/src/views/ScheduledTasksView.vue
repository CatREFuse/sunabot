<script setup lang="ts">
import { computed } from "vue";
import ScheduledTaskCatalog from "../components/scheduled-tasks/ScheduledTaskCatalog.vue";
import { activeAgentIdState } from "../composables/agentScope";

const agentId = computed(() => activeAgentIdState.value || "plana");
</script>

<template>
  <ScheduledTaskCatalog :agent-id="agentId" />
</template>
