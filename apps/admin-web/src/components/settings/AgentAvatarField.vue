<script setup lang="ts">
import { computed } from "vue";
import type { AgentAvatarInput, AgentSummary } from "../../types";
import { agentAvatarUrl } from "../../utils/agentIdentity";
import AgentAvatarPicker from "../agents/AgentAvatarPicker.vue";
import IdentityAvatar from "../ui/IdentityAvatar.vue";

const props = withDefaults(defineProps<{
  agent?: AgentSummary;
  busy?: boolean;
  error?: string;
  success?: string;
}>(), {
  agent: undefined,
  busy: false,
  error: "",
  success: ""
});
const emit = defineEmits<{ upload: [input: AgentAvatarInput] }>();
const avatar = computed(() => agentAvatarUrl(props.agent));
const feedback = computed(() => props.error || props.success);
</script>

<template>
  <div class="grid gap-4 border-y border-line py-5 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
    <div class="flex min-w-0 items-center gap-4">
      <IdentityAvatar :src="avatar" :name="agent?.name" size="lg" />
      <div class="min-w-0">
        <strong class="block text-sm font-medium text-display">WebUI 头像</strong>
        <small class="mt-1 block text-xs text-mute">PNG、JPEG 或 WebP</small>
      </div>
    </div>
    <AgentAvatarPicker
      class="sm:justify-self-end"
      :label="busy ? '上传中' : agent?.avatarPath ? '更换头像' : '上传头像'"
      :disabled="busy || !agent"
      @change="emit('upload', $event)"
    />
    <p
      v-if="feedback"
      class="text-sm sm:col-span-2"
      :class="error ? 'text-accent' : 'text-success'"
      :role="error ? 'alert' : 'status'"
    >{{ feedback }}</p>
  </div>
</template>
