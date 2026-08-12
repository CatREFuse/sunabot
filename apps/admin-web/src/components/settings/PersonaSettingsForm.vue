<script setup lang="ts">
import { computed, onMounted, shallowRef } from "vue";
import type { AgentAvatarInput } from "../../types";
import { useAgents } from "../../composables/useAgents";
import AgentAvatarField from "./AgentAvatarField.vue";
import SettingsConfirmInput from "./SettingsConfirmInput.vue";
import type { ConfigSectionValueMap } from "../../types";

const props = defineProps<{ agentId: string }>();
const draft = defineModel<ConfigSectionValueMap["bot"]>({ required: true });
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
      <p class="mt-2 text-sm leading-6 text-mute">管理当前 Agent 的显示身份和管理员身份。</p>
    </div>
    <div class="settings-group grid gap-5">
      <div>
        <h3 class="settings-group-title">显示身份</h3>
        <p class="settings-group-description">头像只用于管理台显示。</p>
      </div>
      <AgentAvatarField
        :agent="agent"
        :busy="avatarBusy"
        :error="avatarError || agentsState.error.value"
        :success="avatarSuccess"
        @upload="uploadAvatar"
      />
    </div>
    <div class="settings-group grid gap-5">
      <h3 class="settings-group-title">Agent 标识</h3>
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
    <div class="settings-group grid gap-5">
      <div>
        <h3 class="settings-group-title">管理员身份</h3>
        <p class="settings-group-description">用于管理员会话识别和称呼。</p>
      </div>
      <div class="grid gap-5 sm:grid-cols-2">
        <label class="field">
          <span class="field-label">管理员 QQ</span>
          <SettingsConfirmInput v-model.trim="draft.adminQq" type="text" inputmode="numeric" autocomplete="off" confirm-label="确认管理员 QQ" />
        </label>
        <label class="field">
          <span class="field-label">管理员称呼</span>
          <SettingsConfirmInput v-model.trim="draft.adminName" type="text" autocomplete="off" confirm-label="确认管理员称呼" />
        </label>
      </div>
    </div>
  </section>
</template>
