<script setup lang="ts">
import { computed, onMounted, shallowRef } from "vue";
import type { AgentAvatarInput } from "../../types";
import { useAgents } from "../../composables/useAgents";
import AgentAvatarField from "./AgentAvatarField.vue";

const props = defineProps<{ agentId: string }>();
const agentsState = useAgents();
const avatarBusy = shallowRef(false);
const avatarError = shallowRef("");
const avatarSuccess = shallowRef("");
const agent = computed(() => agentsState.agents.value.find((item) => item.id === props.agentId));

onMounted(() => void agentsState.load().catch(() => undefined));

async function uploadAvatar(input: AgentAvatarInput) {
  avatarBusy.value = true;
  avatarError.value = "";
  avatarSuccess.value = "";
  try {
    await agentsState.updateAvatar(props.agentId, input);
    avatarSuccess.value = "头像已更新";
  } catch (error) {
    avatarError.value = error instanceof Error ? error.message : "头像上传失败";
  } finally {
    avatarBusy.value = false;
  }
}
</script>

<template>
  <section class="grid gap-8">
    <div>
      <h2 class="section-title">Agent 身份</h2>
    </div>
    <div class="grid gap-5">
      <AgentAvatarField
        :agent="agent"
        :busy="avatarBusy"
        :error="avatarError || agentsState.error.value"
        :success="avatarSuccess"
        @upload="uploadAvatar"
      />
      <dl class="grid gap-5 sm:grid-cols-2">
        <div class="field">
          <dt class="field-label">Agent ID</dt>
          <dd class="break-all font-mono text-sm text-display">{{ agentId }}</dd>
        </div>
        <div class="field">
          <dt class="field-label">工作目录</dt>
          <dd class="break-all font-mono text-sm text-display">{{ agent?.workspace || "--" }}</dd>
        </div>
      </dl>
    </div>
  </section>
</template>
