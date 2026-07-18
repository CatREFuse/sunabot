<script setup lang="ts">
import { computed, onBeforeUnmount, watch } from "vue";
import VoiceProfileSettings from "../components/voice/VoiceProfileSettings.vue";
import PageHeader from "../components/ui/PageHeader.vue";
import { activeAgentIdState } from "../composables/agentScope";
import { useVoiceProfile } from "../composables/useVoiceProfile";

const agentId = computed(() => activeAgentIdState.value || "plana");
const voice = useVoiceProfile();

watch(
  agentId,
  (value) => {
    void voice.load(value);
  },
  { immediate: true, flush: "sync" },
);
onBeforeUnmount(() => voice.dispose());
</script>

<template>
  <div class="page-shell">
    <div class="page-frame">
      <PageHeader title="语音">
        <template #actions>
          <button
            class="btn"
            type="button"
            :disabled="
              voice.loading.value ||
              voice.saving.value ||
              voice.probing.value ||
              Boolean(voice.busyLanguage.value)
            "
            @click="voice.load(agentId)"
          >
            <i
              class="bx"
              :class="
                voice.loading.value ? 'bx-loader-alt bx-spin' : 'bx-refresh'
              "
              aria-hidden="true"
            ></i>
            {{ voice.loading.value ? "刷新中" : "刷新" }}
          </button>
        </template>
      </PageHeader>

      <VoiceProfileSettings
        :key="agentId"
        :profile="voice.profile.value"
        :provider="voice.provider.value"
        :loading="voice.loading.value"
        :saving="voice.saving.value"
        :probing="voice.probing.value"
        :busy-language="voice.busyLanguage.value"
        :error="voice.error.value"
        :message="voice.message.value"
        @save-settings="voice.saveSettings(agentId, $event)"
        @probe="voice.probe(agentId)"
        @put-reference="
          voice.putReference(agentId, $event.language, {
            file: $event.file,
            referenceText: $event.referenceText,
          })
        "
        @delete-reference="voice.deleteReference(agentId, $event)"
      />
    </div>
  </div>
</template>
