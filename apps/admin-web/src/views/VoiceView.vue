<script setup lang="ts">
import { computed, onBeforeUnmount, watch } from "vue";
import VoiceProfileSettings from "../components/voice/VoiceProfileSettings.vue";
import VoiceServiceControls from "../components/voice/VoiceServiceControls.vue";
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
              Boolean(voice.serviceAction.value) ||
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

      <VoiceServiceControls
        :provider="voice.provider.value"
        :action="voice.serviceAction.value"
        :error="voice.serviceError.value"
        :message="voice.serviceMessage.value"
        @check="voice.checkService(agentId)"
        @start="voice.startService(agentId)"
        @stop="voice.stopService(agentId)"
      />

      <VoiceProfileSettings
        :key="agentId"
        class="mt-12 border-t border-visible pt-8"
        :profile="voice.profile.value"
        :loading="voice.loading.value"
        :saving="voice.saving.value"
        :busy-language="voice.busyLanguage.value"
        :error="voice.error.value"
        :message="voice.message.value"
        @save-settings="voice.saveSettings(agentId, $event)"
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
