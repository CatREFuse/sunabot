<script setup lang="ts">
import { computed, reactive, shallowRef, watch } from "vue";
import type { AgentAvatarInput } from "../../types";
import type { AgentConfigImportPayload } from "../../composables/useAgentConfigImport";
import AgentAvatarPicker from "./AgentAvatarPicker.vue";
import AgentConfigImportPicker from "./AgentConfigImportPicker.vue";
import DialogOverlay from "../ui/DialogOverlay.vue";
import IdentityAvatar from "../ui/IdentityAvatar.vue";

const props = defineProps<{ open: boolean; busy?: boolean; error?: string }>();
const emit = defineEmits<{
  close: [];
  submit: [input: {
    id: string;
    name: string;
    avatar?: { fileName: string; dataBase64: string };
    import?: AgentConfigImportPayload;
  }];
}>();
const draft = reactive({ name: "", id: "" });
const avatar = shallowRef<AgentAvatarInput>();
const imported = shallowRef<AgentConfigImportPayload>();
const valid = computed(() => draft.name.trim().length > 0 && /^[a-z][a-z0-9-]{1,31}$/.test(draft.id.trim()));

watch(() => props.open, (open) => {
  if (open) return;
  draft.name = "";
  draft.id = "";
  avatar.value = undefined;
  imported.value = undefined;
});

function updateName() {
  if (!draft.id || /^[a-z0-9-]*$/.test(draft.id)) {
    const generated = draft.name.trim().toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
    if (generated) draft.id = generated;
  }
}

function submit() {
  if (!valid.value) return;
  emit("submit", {
    id: draft.id.trim(),
    name: draft.name.trim(),
    ...(avatar.value ? { avatar: avatar.value } : {}),
    ...(imported.value ? { import: imported.value } : {})
  });
}
</script>

<template>
  <DialogOverlay :open="open" labelledby="create-agent-title" @close="emit('close')">
    <form class="w-full max-w-lg border border-visible bg-panel p-6 md:p-8" @submit.prevent="submit">
      <div class="flex items-center justify-between gap-4">
        <h2 id="create-agent-title" class="text-2xl font-medium text-display">新增 Agent</h2>
        <button class="icon-btn" type="button" aria-label="关闭" @click="emit('close')"><i class="bx bx-x" aria-hidden="true"></i></button>
      </div>
      <div class="mt-8 grid gap-5">
        <label class="field">
          <span class="field-label">名称</span>
          <input v-model="draft.name" class="control" maxlength="40" autocomplete="off" required data-dialog-initial-focus @input="updateName">
        </label>
        <label class="field">
          <span class="field-label">Agent ID</span>
          <input v-model="draft.id" class="control" maxlength="32" pattern="[a-z][a-z0-9-]{1,31}" autocomplete="off" required>
          <small class="text-xs text-mute">创建后不可修改</small>
        </label>
        <div class="field">
          <span class="field-label">头像</span>
          <div class="flex items-center gap-4">
            <IdentityAvatar :src="avatar?.dataBase64" :name="draft.name" size="lg" />
            <AgentAvatarPicker :label="avatar ? '重新裁剪' : '选择并裁剪'" :disabled="busy" @change="avatar = $event" />
          </div>
        </div>
        <AgentConfigImportPicker :disabled="busy" @change="imported = $event" />
      </div>
      <p v-if="error" class="mt-5 text-sm text-accent" role="alert">{{ error }}</p>
      <div class="mt-8 flex justify-end gap-3">
        <button class="btn" type="button" @click="emit('close')">取消</button>
        <button class="btn btn-primary" type="submit" :disabled="busy || !valid">{{ busy ? "创建中" : "创建 Agent" }}</button>
      </div>
    </form>
  </DialogOverlay>
</template>
