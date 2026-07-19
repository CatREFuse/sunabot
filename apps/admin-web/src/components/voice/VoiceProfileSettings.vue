<script setup lang="ts">
import { computed, ref, shallowRef, useTemplateRef, watch } from "vue";
import {
  MAX_VOICE_REFERENCE_BYTES,
  MAX_VOICE_REFERENCE_TEXT_LENGTH,
  normalizeVoiceReferenceText,
} from "../../composables/useVoiceProfile";
import type {
  VoiceLanguage,
  VoiceProfile,
  VoiceProfileSettingsInput,
  VoiceReferenceInput,
} from "../../types/voice";
import { VOICE_LANGUAGES, VOICE_LANGUAGE_LABELS } from "../../types/voice";
import DialogOverlay from "../ui/DialogOverlay.vue";
import ToggleSwitch from "../ui/ToggleSwitch.vue";

const props = withDefaults(
  defineProps<{
    profile: VoiceProfile | null;
    loading?: boolean;
    saving?: boolean;
    busyLanguage?: VoiceLanguage | "";
    error?: string;
    message?: string;
  }>(),
  {
    loading: false,
    saving: false,
    busyLanguage: "",
    error: "",
    message: "",
  },
);
const emit = defineEmits<{
  saveSettings: [input: VoiceProfileSettingsInput];
  putReference: [input: { language: VoiceLanguage } & VoiceReferenceInput];
  deleteReference: [language: VoiceLanguage];
}>();

const fileInput = useTemplateRef<HTMLInputElement>("fileInput");
const draftEnabled = shallowRef(false);
const draftDefaultLanguage = shallowRef<VoiceLanguage>("ja");
const selectedLanguage = shallowRef<VoiceLanguage>("ja");
const uploadLanguage = shallowRef<VoiceLanguage | null>(null);
const uploadFile = shallowRef<File | null>(null);
const uploadReferenceText = ref("");
const uploadError = shallowRef("");
const uploadSubmitted = shallowRef(false);
const uploadBusySeen = shallowRef(false);
const deleteLanguage = shallowRef<VoiceLanguage | null>(null);
let loadedSettings: VoiceProfileSettingsInput | null = null;

const currentReference = computed(
  () => props.profile?.languages[selectedLanguage.value] ?? null,
);
const uploadReference = computed(() =>
  uploadLanguage.value
    ? (props.profile?.languages[uploadLanguage.value] ?? null)
    : null,
);
const deleteReference = computed(() =>
  deleteLanguage.value
    ? (props.profile?.languages[deleteLanguage.value] ?? null)
    : null,
);
const controlsBusy = computed(
  () =>
    props.loading ||
    props.saving ||
    Boolean(props.busyLanguage),
);
const settingsDirty = computed(
  () =>
    Boolean(props.profile) &&
    (draftEnabled.value !== props.profile?.enabled ||
      draftDefaultLanguage.value !== props.profile?.defaultLanguage),
);
const missingDefaultReference = computed(() =>
  Boolean(
    props.profile &&
    draftEnabled.value &&
    !props.profile.languages[draftDefaultLanguage.value],
  ),
);
watch(
  () => props.profile,
  (profile) => {
    if (!profile) {
      loadedSettings = null;
      draftEnabled.value = false;
      draftDefaultLanguage.value = "ja";
      resetTransientDialogs();
      return;
    }
    const hasUnsavedSettings =
      Boolean(loadedSettings) &&
      (draftEnabled.value !== loadedSettings?.enabled ||
        draftDefaultLanguage.value !== loadedSettings?.defaultLanguage);
    if (!hasUnsavedSettings) {
      draftEnabled.value = profile.enabled;
      draftDefaultLanguage.value = profile.defaultLanguage;
    }
    if (!loadedSettings) selectedLanguage.value = profile.defaultLanguage;
    loadedSettings = {
      enabled: profile.enabled,
      defaultLanguage: profile.defaultLanguage,
    };
  },
  { immediate: true },
);

watch(
  () => props.busyLanguage,
  (busyLanguage) => {
    if (!uploadSubmitted.value || !uploadLanguage.value) return;
    if (busyLanguage === uploadLanguage.value) {
      uploadBusySeen.value = true;
      return;
    }
    if (!busyLanguage && uploadBusySeen.value) {
      if (props.error) {
        uploadError.value = props.error;
        uploadSubmitted.value = false;
        uploadBusySeen.value = false;
      } else {
        closeUpload();
      }
    }
  },
);

function saveSettings() {
  if (
    !props.profile ||
    !settingsDirty.value ||
    missingDefaultReference.value ||
    controlsBusy.value
  )
    return;
  emit("saveSettings", {
    enabled: draftEnabled.value,
    defaultLanguage: draftDefaultLanguage.value,
  });
}

function openUpload(language: VoiceLanguage) {
  if (controlsBusy.value) return;
  uploadLanguage.value = language;
  uploadFile.value = null;
  uploadReferenceText.value =
    props.profile?.languages[language]?.referenceText ?? "";
  uploadError.value = "";
  uploadSubmitted.value = false;
  uploadBusySeen.value = false;
  if (fileInput.value) fileInput.value.value = "";
}

function closeUpload() {
  if (uploadLanguage.value && props.busyLanguage === uploadLanguage.value)
    return;
  resetUpload();
}

function resetUpload() {
  uploadLanguage.value = null;
  uploadFile.value = null;
  uploadReferenceText.value = "";
  uploadError.value = "";
  uploadSubmitted.value = false;
  uploadBusySeen.value = false;
  if (fileInput.value) fileInput.value.value = "";
}

function resetTransientDialogs() {
  resetUpload();
  deleteLanguage.value = null;
}

function chooseAudio() {
  fileInput.value?.click();
}

function selectAudio(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0] ?? null;
  input.value = "";
  if (!file) return;
  if (!file.size) {
    uploadFile.value = null;
    uploadError.value = "音频文件为空";
    return;
  }
  if (file.size > MAX_VOICE_REFERENCE_BYTES) {
    uploadFile.value = null;
    uploadError.value = "音频文件不能超过 8 MB";
    return;
  }
  if (file.type && !file.type.startsWith("audio/")) {
    uploadFile.value = null;
    uploadError.value = "请选择音频文件";
    return;
  }
  uploadFile.value = file;
  uploadError.value = "";
}

function submitUpload() {
  if (!uploadLanguage.value || !uploadFile.value || props.busyLanguage) {
    if (!uploadFile.value) uploadError.value = "请选择参考音频";
    return;
  }
  const referenceText = normalizeVoiceReferenceText(uploadReferenceText.value);
  if (!referenceText) {
    uploadError.value = uploadReferenceText.value.trim()
      ? "参考台词无效"
      : "请填写参考台词";
    return;
  }
  uploadError.value = "";
  uploadSubmitted.value = true;
  uploadBusySeen.value = false;
  emit("putReference", {
    language: uploadLanguage.value,
    file: uploadFile.value,
    referenceText,
  });
}

function confirmDelete() {
  if (!deleteLanguage.value || props.busyLanguage) return;
  emit("deleteReference", deleteLanguage.value);
  deleteLanguage.value = null;
}

function formatBytes(bytes: number) {
  if (bytes < 1024 * 1024)
    return `${Math.max(1, Math.round(bytes / 1024)).toLocaleString("zh-CN")} KB`;
  return `${new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 1 }).format(bytes / 1024 / 1024)} MB`;
}

function formatDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}
</script>

<template>
  <section aria-labelledby="voice-settings-title">
    <header
      class="flex flex-col items-stretch justify-between gap-4 sm:flex-row sm:items-end"
    >
      <div class="min-w-0">
        <h2 id="voice-settings-title" class="section-title">语音发送</h2>
        <p class="mt-1 text-xs leading-5 text-mute">
          在重要表达中发送同内容语音
        </p>
      </div>
      <button
        class="btn btn-primary shrink-0"
        type="button"
        :disabled="!settingsDirty || missingDefaultReference || controlsBusy"
        @click="saveSettings"
      >
        <i
          class="bx"
          :class="saving ? 'bx-loader-alt bx-spin' : 'bx-save'"
          aria-hidden="true"
        ></i>
        {{ saving ? "保存中" : "保存设置" }}
      </button>
    </header>

    <div class="mt-6 border-y border-line">
      <div
        class="divider-row flex-col items-stretch sm:flex-row sm:items-center"
      >
        <ToggleSwitch
          v-model="draftEnabled"
          class="w-full"
          label="启用语音"
          description="早安、晚安、喜爱、激动和害羞等表达可伴随语音"
          :disabled="!profile || controlsBusy"
        />
      </div>

      <label
        class="divider-row flex-col items-stretch sm:flex-row sm:items-center"
      >
        <span class="min-w-0">
          <span class="block text-sm text-ink">默认语音语言</span>
          <span class="mt-1 block text-xs leading-5 text-mute"
            >语音工具未指定语言时使用</span
          >
        </span>
        <select
          v-model="draftDefaultLanguage"
          class="control sm:w-52"
          :disabled="!profile || controlsBusy"
        >
          <option
            v-for="language in VOICE_LANGUAGES"
            :key="language"
            :value="language"
          >
            {{ VOICE_LANGUAGE_LABELS[language] }}
          </option>
        </select>
      </label>

    </div>

    <p
      v-if="missingDefaultReference"
      class="mt-4 inline-state"
      data-kind="warning"
    >
      请先添加默认语言的参考音频
    </p>
    <p
      v-else-if="error"
      class="mt-4 inline-state"
      data-kind="error"
      role="alert"
    >
      {{ error }}
    </p>
    <p
      v-else-if="message"
      class="mt-4 inline-state"
      data-kind="success"
      aria-live="polite"
    >
      {{ message }}
    </p>
  </section>

  <section
    class="mt-12 border-t border-visible pt-8"
    aria-labelledby="voice-references-title"
  >
    <header
      class="flex flex-col items-stretch justify-between gap-4 sm:flex-row sm:items-end"
    >
      <div class="min-w-0">
        <h2 id="voice-references-title" class="section-title">参考音频</h2>
        <p class="mt-1 text-xs leading-5 text-mute">
          每种语言使用独立的参考音频和台词
        </p>
      </div>
      <div class="segmented self-start" role="group" aria-label="参考音频语言">
        <button
          v-for="language in VOICE_LANGUAGES"
          :key="language"
          class="segmented-button"
          type="button"
          :aria-pressed="selectedLanguage === language"
          @click="selectedLanguage = language"
        >
          {{ VOICE_LANGUAGE_LABELS[language] }}
        </button>
      </div>
    </header>

    <div class="mt-6 border-y border-line">
      <div
        class="grid min-w-0 gap-6 py-6 md:grid-cols-[minmax(0,1fr)_auto] md:items-center"
      >
        <div class="min-w-0">
          <div class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h3 class="text-lg font-medium text-display">
              {{ VOICE_LANGUAGE_LABELS[selectedLanguage] }}
            </h3>
            <span class="inline-state">{{
              currentReference ? "已设置" : loading ? "读取中" : "未设置"
            }}</span>
          </div>

          <template v-if="currentReference">
            <p
              class="mt-4 truncate text-sm font-medium text-ink"
              :title="currentReference.fileName"
            >
              {{ currentReference.fileName }}
            </p>
            <p class="mt-1 text-xs text-mute">
              {{ currentReference.mimeType }} ·
              {{ formatBytes(currentReference.sizeBytes) }} ·
              {{ formatDate(currentReference.updatedAt) }}
            </p>
            <blockquote
              class="mt-4 border-l-2 border-visible pl-4 text-sm leading-6 text-ink"
            >
              {{ currentReference.referenceText }}
            </blockquote>
          </template>
          <p v-else class="mt-4 text-sm text-mute">还没有参考音频</p>
        </div>

        <div class="flex flex-wrap items-center gap-2 md:justify-end">
          <button
            class="btn btn-primary"
            type="button"
            :disabled="controlsBusy || !profile"
            @click="openUpload(selectedLanguage)"
          >
            <i
              class="bx"
              :class="
                busyLanguage === selectedLanguage
                  ? 'bx-loader-alt bx-spin'
                  : 'bx-upload'
              "
              aria-hidden="true"
            ></i>
            {{
              busyLanguage === selectedLanguage
                ? "处理中"
                : currentReference
                  ? "替换音频"
                  : "添加音频"
            }}
          </button>
          <button
            v-if="currentReference"
            class="btn btn-danger"
            type="button"
            :disabled="controlsBusy"
            @click="deleteLanguage = selectedLanguage"
          >
            <i class="bx bx-trash" aria-hidden="true"></i>删除
          </button>
        </div>
      </div>
    </div>
  </section>

  <DialogOverlay
    :open="Boolean(uploadLanguage)"
    :dismissible="!uploadLanguage || busyLanguage !== uploadLanguage"
    labelledby="voice-upload-title"
    @close="closeUpload"
  >
    <form
      class="grid max-h-[calc(100dvh-32px)] w-full max-w-xl grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden rounded border border-visible bg-panel"
      novalidate
      @submit.prevent="submitUpload"
    >
      <header
        class="flex items-center justify-between gap-4 border-b border-line p-4 md:p-5"
      >
        <div class="min-w-0">
          <h2 id="voice-upload-title" class="text-xl font-medium text-display">
            {{ uploadReference ? "替换" : "添加"
            }}{{
              uploadLanguage ? VOICE_LANGUAGE_LABELS[uploadLanguage] : ""
            }}参考音频
          </h2>
          <p v-if="uploadReference" class="mt-1 truncate text-xs text-mute">
            {{ uploadReference.fileName }}
          </p>
        </div>
        <button
          class="icon-btn"
          type="button"
          aria-label="关闭"
          :disabled="Boolean(uploadLanguage && busyLanguage === uploadLanguage)"
          @click="closeUpload"
        >
          <i class="bx bx-x text-2xl" aria-hidden="true"></i>
        </button>
      </header>

      <div class="min-h-0 overflow-y-auto p-4 md:p-5">
        <div class="field">
          <span class="field-label">参考音频</span>
          <button
            class="control flex items-center justify-between gap-3 text-left"
            type="button"
            :disabled="Boolean(busyLanguage)"
            @click="chooseAudio"
          >
            <span class="min-w-0 truncate">{{
              uploadFile?.name || "选择音频文件"
            }}</span>
            <i
              class="bx bx-folder-open shrink-0 text-xl"
              aria-hidden="true"
            ></i>
          </button>
          <input
            ref="fileInput"
            class="sr-only"
            type="file"
            accept="audio/*"
            aria-label="选择参考音频"
            @change="selectAudio"
          />
          <small class="text-xs text-mute">最大 8 MB</small>
        </div>

        <label class="field mt-6">
          <span
            class="field-label flex flex-wrap items-center justify-between gap-2"
          >
            <span>参考台词</span>
            <small class="font-mono text-[10px] text-mute"
              >最多 {{ MAX_VOICE_REFERENCE_TEXT_LENGTH }} 个字</small
            >
          </span>
          <textarea
            v-model="uploadReferenceText"
            class="control min-h-32"
            required
            :disabled="Boolean(busyLanguage)"
            :placeholder="
              uploadLanguage === 'ja'
                ? '音声と一致する日本語の台詞を入力'
                : uploadLanguage === 'en'
                  ? 'Enter the exact words spoken in the audio'
                  : '请输入音频中的中文台词'
            "
          ></textarea>
          <small class="text-xs text-mute">填写与音频完全一致的内容</small>
        </label>
      </div>

      <footer
        class="flex flex-wrap items-center justify-between gap-3 border-t border-line p-4 md:p-5"
      >
        <span
          class="inline-state"
          :data-kind="uploadError ? 'error' : undefined"
          role="alert"
          >{{ uploadError }}</span
        >
        <div class="flex justify-end gap-2">
          <button
            class="btn btn-ghost"
            type="button"
            :disabled="Boolean(busyLanguage)"
            @click="closeUpload"
          >
            取消
          </button>
          <button
            class="btn btn-primary"
            type="submit"
            :disabled="Boolean(busyLanguage) || !uploadFile"
          >
            <i
              class="bx"
              :class="
                uploadLanguage && busyLanguage === uploadLanguage
                  ? 'bx-loader-alt bx-spin'
                  : 'bx-upload'
              "
              aria-hidden="true"
            ></i>
            {{
              uploadLanguage && busyLanguage === uploadLanguage
                ? "保存中"
                : "保存并上传"
            }}
          </button>
        </div>
      </footer>
    </form>
  </DialogOverlay>

  <DialogOverlay
    :open="Boolean(deleteLanguage)"
    labelledby="voice-delete-title"
    :dismissible="!busyLanguage"
    @close="deleteLanguage = null"
  >
    <section class="w-full max-w-md rounded border border-visible bg-panel p-6">
      <h2 id="voice-delete-title" class="text-xl font-medium text-display">
        删除{{
          deleteLanguage ? VOICE_LANGUAGE_LABELS[deleteLanguage] : ""
        }}参考音频？
      </h2>
      <p v-if="deleteReference" class="mt-3 truncate text-sm text-ink">
        {{ deleteReference.fileName }}
      </p>
      <div class="mt-8 flex flex-wrap justify-end gap-2">
        <button
          class="btn btn-ghost"
          type="button"
          :disabled="Boolean(busyLanguage)"
          @click="deleteLanguage = null"
        >
          取消
        </button>
        <button
          class="btn btn-danger"
          type="button"
          :disabled="Boolean(busyLanguage)"
          @click="confirmDelete"
        >
          <i class="bx bx-trash" aria-hidden="true"></i>删除
        </button>
      </div>
    </section>
  </DialogOverlay>
</template>
