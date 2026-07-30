<script setup lang="ts">
import { computed, onBeforeUnmount, watch } from "vue";
import { activeAgentIdState } from "../../composables/agentScope";
import { useSelfieReferences } from "../../composables/useSelfieReferences";
import SelfieReferenceManager from "./SelfieReferenceManager.vue";
import type { WorkbenchBackend } from "../../types/workbench";

const references = useSelfieReferences();
const agentId = computed(() => activeAgentIdState.value || "plana");

watch(activeAgentIdState, (nextAgentId) => {
  void references.load(nextAgentId || "plana");
}, { immediate: true, flush: "sync" });
onBeforeUnmount(references.dispose);

function upload(entries: Parameters<typeof references.upload>[1]) {
  return references.upload(agentId.value, entries);
}

function updateNote(id: string, note: string, workbench: WorkbenchBackend) {
  return references.updateNote(agentId.value, id, note, workbench);
}

function remove(id: string, workbench: WorkbenchBackend) {
  return references.remove(agentId.value, id, workbench);
}
</script>

<template>
  <SelfieReferenceManager
    :key="agentId"
    :images="references.images.value"
    :max-images="references.maxImages.value"
    :loading="references.loading.value"
    :uploading="references.uploading.value"
    :updating-id="references.updatingId.value"
    :deleting-id="references.deletingId.value"
    :status="references.status.value"
    @upload="upload"
    @update-note="updateNote"
    @remove="remove"
  />
</template>
